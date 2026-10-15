import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { lint } from "markdownlint/sync";

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
    rootDirs.has(parts[0]) && (parts[0] !== "docs" || docDirs.has(parts[1]))
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
  const ui = /\.(tsx|jsx|html)$/.test(path) || /\/(ui|miniapp)\//.test(path);
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
      const syntax =
        ts.isJsxAttribute(node.parent) &&
        /^(className|id|type|role|data-|aria-hidden)/.test(
          node.parent.name.getText(source),
        );
      if (!translation && !syntax)
        issues.push("UI literal requires review or translation key");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return issues;
}

/** @param {string} directory @returns {string[]} */
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", "node_modules", ".env"].includes(entry.name)) return [];
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/** @param {string} text */
function anchors(text) {
  return [...text.matchAll(/^#+\s+(.+)$/gm)].map((match) =>
    match[1]
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_ -]/gu, "")
      .replace(/ /g, "-"),
  );
}

export function check() {
  const errors = [];
  const markdown = lint({
    files: walk(root).filter((path) => path.endsWith(".md")),
    config: { MD013: false },
  });
  for (const [path, issues] of Object.entries(markdown)) {
    for (const issue of issues)
      errors.push(
        `${path}: ${issue.ruleNames.join("/")} line ${issue.lineNumber}`,
      );
  }
  for (const absolute of walk(root)) {
    const path = absolute.slice(root.length + 1);
    if (!pathAllowed(path)) errors.push(`Disallowed path: ${path}`);
    const text = readFileSync(absolute, "utf8");
    if (!path.includes("/locales/") && /\p{Script=Cyrillic}/u.test(text))
      errors.push(`${path}: English required outside locales`);
    if (/\.(?:[cm]?[jt]sx?|html)$/.test(path)) {
      for (const issue of uiViolations(path, text))
        errors.push(`${path}: ${issue}`);
    }
    if (path.endsWith(".md")) {
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1];
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
  const lock = JSON.parse(
    readFileSync(resolve(root, "package-lock.json"), "utf8"),
  );
  const licenses = new Set([
    "MIT",
    "ISC",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "0BSD",
    "Python-2.0",
    "(MIT OR CC0-1.0)",
  ]);
  for (const [path, info] of Object.entries(lock.packages)) {
    if (
      path &&
      !licenses.has(/** @type {{ license: string }} */ (info).license)
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
