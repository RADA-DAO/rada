import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { lint } from "markdownlint/sync";
import {
  architectureViolations,
  missingHistoricalMigrations,
  publicSqlViews,
} from "./architecture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootFiles = new Set([
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "AGENTS.md",
  "CLAUDE.md",
  "LICENSE",
  ".gitignore",
  ".env.example",
  ".node-version",
  ".prettierignore",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "eslint.config.mjs",
]);
const rootDirs = new Set([
  "apps",
  "modules",
  "packages",
  "db",
  "infra",
  "docs",
  "tools",
  ".github",
]);
const docDirs = new Set(["architecture", "contributing", "adr"]);

/** @param {string} path */
export function pathAllowed(path) {
  const parts = path.split("/");
  if (/\d{4}-\d{2}-\d{2}|_REPORT|^NOTES|\.log$/i.test(basename(path)))
    return false;
  if (parts.length === 1) return rootFiles.has(path);
  return (
    rootDirs.has(parts[0] ?? "") &&
    (parts[0] !== "docs" || docDirs.has(parts[1] ?? ""))
  );
}

/** @param {string} subject */
export function conventional(subject) {
  return /^(feat|fix|refactor|docs|test|chore|build|ci|perf|revert)(\([a-z0-9/-]+\))?!?: .+/.test(
    subject,
  );
}

/** @param {string} path @param {string} text */
export function uiViolations(path, text) {
  if (path.includes("/locales/")) return [];
  const issues = [];
  if (/\p{Script=Cyrillic}/u.test(text)) issues.push("non-English source");
  const ui =
    /\.(tsx|jsx|html)$/.test(path) ||
    (/\/(ui|miniapp)\//.test(path) && !/\/(scripts|test|tests)\//.test(path));
  if (!ui) return issues;
  if (path.endsWith(".html")) {
    if (
      />\s*[^<\s][^<]*</.test(text) ||
      /(?:title|placeholder|aria-label|alt)\s*=\s*["'][^"']/.test(text)
    )
      issues.push("literal HTML text");
    return issues;
  }
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const textBindings = new Set();
  /** @param {import('typescript').Node} node */
  function collectTextBindings(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isStringLiteralLike(node.initializer) ||
        (ts.isAsExpression(node.initializer) &&
          ts.isStringLiteralLike(node.initializer.expression)))
    )
      textBindings.add(node.name.text);
    ts.forEachChild(node, collectTextBindings);
  }
  collectTextBindings(source);
  /** @param {import('typescript').Node} node */
  function visibleValue(node) {
    const parent = node.parent;
    if (
      (ts.isJsxAttribute(parent) &&
        /^(aria-label|aria-description|alt|title|placeholder)$/.test(
          parent.name.getText(source),
        )) ||
      (ts.isJsxExpression(parent) &&
        ((ts.isJsxAttribute(parent.parent) &&
          /^(aria-label|aria-description|alt|title|placeholder)$/.test(
            parent.parent.name.getText(source),
          )) ||
          ts.isJsxElement(parent.parent) ||
          ts.isJsxSelfClosingElement(parent.parent)))
    )
      return true;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      /\.(textContent|innerText|title|placeholder|ariaLabel|ariaDescription|alt)$/.test(
        parent.left.getText(source),
      )
    )
      return true;
    if (
      ts.isCallExpression(parent) &&
      parent.expression.getText(source).endsWith("setAttribute") &&
      parent.arguments[1] === node &&
      /^(aria-label|aria-description|alt|title|placeholder)$/.test(
        parent.arguments[0]?.getText(source).replace(/["']/g, "") ?? "",
      )
    )
      return true;
    if (
      ts.isPropertyAssignment(parent) &&
      parent.initializer === node &&
      ts.isObjectLiteralExpression(parent.parent) &&
      ts.isCallExpression(parent.parent.parent) &&
      ["Sheet", "EmptyState", "ErrorState", "Card"].includes(
        parent.parent.parent.expression.getText(source).split(".").at(-1) ?? "",
      ) &&
      /^(title|label|message|closeLabel|retryLabel)$/.test(
        parent.name.getText(source).replace(/["']/g, ""),
      )
    )
      return true;
    if (ts.isCallExpression(parent)) {
      const component =
        parent.expression.getText(source).split(".").at(-1) ?? "";
      if (
        ["Button", "EmptyState", "ErrorState", "Sheet"].includes(component) &&
        parent.arguments[0] === node
      )
        return true;
      if (
        ["Sheet", "EmptyState", "ErrorState", "Card"].includes(component) &&
        parent.arguments.some(
          (argument) =>
            ts.isObjectLiteralExpression(argument) &&
            argument.properties.some(
              (property) =>
                ts.isPropertyAssignment(property) &&
                property.initializer === node &&
                /^(title|label|message|closeLabel|retryLabel)$/.test(
                  property.name.getText(source).replace(/["']/g, ""),
                ),
            ),
        )
      )
        return true;
    }
    return false;
  }
  /** @param {import('typescript').Node} node */
  function visit(node) {
    if (ts.isJsxText(node) && node.text.trim()) issues.push("literal JSX text");
    if (
      ts.isStringLiteralLike(node) &&
      node.text.trim() &&
      !ts.isImportDeclaration(node.parent) &&
      !ts.isExportDeclaration(node.parent)
    ) {
      const translation =
        ts.isCallExpression(node.parent) &&
        node.parent.expression.getText(source) === "t" &&
        node.parent.arguments[0] === node;
      const variableInitializer =
        ts.isVariableDeclaration(node.parent) &&
        node.parent.initializer === node;
      if (!translation && !variableInitializer && visibleValue(node))
        issues.push("UI literal requires review or translation key");
    }
    if (
      ts.isIdentifier(node) &&
      textBindings.has(node.text) &&
      visibleValue(node)
    )
      issues.push("UI text variable requires review or translation key");
    ts.forEachChild(node, visit);
  }
  visit(source);
  return issues;
}

/** @param {string} directory @returns {string[]} */
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      [
        ".git",
        "node_modules",
        ".env",
        "dist",
        "playwright-report",
        "test-results",
      ].includes(entry.name)
    )
      return [];
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/** @param {string} text */
function anchors(text) {
  return [...text.matchAll(/^#+\s+(.+)$/gm)].map((match) =>
    (match[1] ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_ -]/gu, "")
      .replace(/ /g, "-"),
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function check() {
  const errors = [];
  const sources = walk(root);
  const views = publicSqlViews(
    new Map(
      sources.map((path) => [
        path.slice(root.length + 1),
        readFileSync(path, "utf8"),
      ]),
    ),
  );
  errors.push(
    ...missingHistoricalMigrations(
      sources.map((path) => path.slice(root.length + 1)),
    ),
  );
  const markdown = lint({
    files: walk(root).filter((path) => path.endsWith(".md")),
    config: { MD013: false },
  });
  for (const [path, issues] of Object.entries(markdown)) {
    for (const issue of issues)
      errors.push(
        `${path}: ${issue.ruleNames.join("/")} line ${String(issue.lineNumber)}`,
      );
  }
  for (const absolute of walk(root)) {
    const path = absolute.slice(root.length + 1);
    if (!pathAllowed(path)) errors.push(`Disallowed path: ${path}`);
    if (/\.(?:png|webp|ico|woff2)$/i.test(path)) continue;
    const text = readFileSync(absolute, "utf8");
    errors.push(...architectureViolations(path, text, views));
    if (!path.includes("/locales/") && /\p{Script=Cyrillic}/u.test(text))
      errors.push(`${path}: English required outside locales`);
    if (/\.(?:[cm]?[jt]sx?|html)$/.test(path)) {
      for (const issue of uiViolations(path, text))
        errors.push(`${path}: ${issue}`);
    }
    if (path.endsWith(".md")) {
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1] ?? "";
        if (/^https?:\/\//.test(target)) continue;
        const [link, anchor] = target.split("#");
        const dest = link ? resolve(dirname(absolute), link) : absolute;
        if (!existsSync(dest)) errors.push(`${path}: missing link ${target}`);
        else if (
          anchor &&
          !anchors(readFileSync(dest, "utf8")).includes(anchor)
        )
          errors.push(`${path}: missing anchor ${target}`);
      }
    }
  }
  /** @type {unknown} */
  const lock = JSON.parse(
    readFileSync(resolve(root, "package-lock.json"), "utf8"),
  );
  if (!record(lock) || !record(lock.packages))
    throw new Error("Invalid package lock");
  const licenses = new Set([
    "MIT",
    "Unlicense",
    "ISC",
    "Apache-2.0",
    "BlueOak-1.0.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "0BSD",
    "Python-2.0",
    "(MIT OR CC0-1.0)",
    "(Apache-2.0 OR MIT)",
  ]);
  for (const [path, info] of Object.entries(lock.packages)) {
    if (
      path &&
      (!record(info) ||
        typeof info.license !== "string" ||
        !licenses.has(info.license))
    )
      errors.push(`Review dependency license: ${path}`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "Repository hygiene, relative links, UI text, and dependency licenses passed.",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  check();
