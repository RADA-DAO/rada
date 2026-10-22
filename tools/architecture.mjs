import { createHash } from "node:crypto";
import { dirname, posix } from "node:path";
import ts from "typescript";
import { designSystemViolations } from "./design-system.mjs";
export { designSystemViolations } from "./design-system.mjs";

// These deployed migrations may move, but their SQL and ledger checksums cannot change.
const historicalMigrations = new Map([
  [
    "modules/identity/db/migrations/0001_identity.sql",
    "fcb195ff1d0ef9040a0c6dde7395909e37511150f119e1f1f3bbcc1776f180f9",
  ],
  [
    "modules/apps/db/migrations/0002_apps.sql",
    "9f37c8d9e6c54081cf9489bef90a9885b6847fd24e903446796cad1b673b4630",
  ],
  [
    "modules/jpegpe/db/migrations/0003_jpegpe.sql",
    "177587effb150050474cd295b05d1ac6905a911f7cfb8a34649bf557d30393e9",
  ],
]);

/** @param {string} path */
function isTest(path) {
  return /(?:^|\/)(?:tests?|fixtures)(?:\/|$)|\.(?:test|spec)\.|(?:^|\/)test-[^/]+\.[cm]?[jt]s$/.test(
    path,
  );
}

/** @param {string} path @param {string} source */
export function codeSizeViolations(path, source) {
  if (
    isTest(path) ||
    /(?:^|\/)generated\//.test(path) ||
    !/\.(?:[cm]?[jt]sx?|css|sql|sh|html)$/.test(path)
  )
    return [];
  const lines = source.replace(/\n$/, "").split("\n").length;
  return lines > 400
    ? [`${path}: code has ${String(lines)} lines (maximum 400)`]
    : [];
}

/** Parameter properties require transformation, which Node strip-types cannot do.
 * @param {string} path @param {string} source
 */
export function parameterPropertyViolations(path, source) {
  if (!/\.[cm]?tsx?$/.test(path)) return [];
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const modifiers = new Set([
    ts.SyntaxKind.PrivateKeyword,
    ts.SyntaxKind.PublicKeyword,
    ts.SyntaxKind.ProtectedKeyword,
    ts.SyntaxKind.ReadonlyKeyword,
    ts.SyntaxKind.OverrideKeyword,
  ]);
  /** @type {string[]} */
  const errors = [];
  /** @param {import('typescript').Node} node */
  function visit(node) {
    if (ts.isConstructorDeclaration(node)) {
      for (const parameter of node.parameters) {
        if (
          !parameter.modifiers?.some((modifier) => modifiers.has(modifier.kind))
        )
          continue;
        const { line, character } = tree.getLineAndCharacterOfPosition(
          parameter.getStart(tree),
        );
        errors.push(
          `${path}:${String(line + 1)}:${String(character + 1)}: constructor parameter properties are incompatible with Node strip-types; declare an explicit field and assign it in the constructor`,
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return errors;
}

/** @param {string} path @param {string} source */
export function moduleImportViolations(path, source) {
  if (!/\.[cm]?[jt]sx?$/.test(path)) return [];
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  /** @type {string[]} */
  const errors = [];
  const owner = /^modules\/([^/]+)\//.exec(path)?.[1];
  /** @param {import('typescript').Node} argument */
  function inspect(argument) {
    if (!ts.isStringLiteralLike(argument)) {
      if (owner)
        errors.push(`${path}: computed module imports are not allowed`);
      return;
    }
    const specifier = argument.text;
    const target = specifier.startsWith(".")
      ? posix.normalize(posix.join(dirname(path), specifier))
      : specifier;
    const module = /^modules\/([^/]+)\/(.*)$/.exec(target);
    if (owner && target.startsWith("apps/"))
      errors.push(`${path}: modules cannot depend on application composition`);
    // Public entries plus two explicitly published strip-safe offline contracts.
    if (
      module &&
      module[1] !== owner &&
      !["index.ts", "ui/index.ts"].includes(module[2] ?? "") &&
      !["modules/jpegpe/storage.ts", "modules/splash/png.ts"].includes(target)
    )
      errors.push(
        `${path}: import ${specifier} must use modules/${module[1] ?? ""}/index.ts, ui/index.ts or a published strip-safe entry`,
      );
    if (owner && /^modules\/[^/]+\/ui\//.test(path) && /\/api\//.test(target))
      errors.push(`${path}: module screens cannot import server code`);
    if (/^(?:file:|\/)/.test(specifier))
      errors.push(`${path}: filesystem imports must use relative public paths`);
    if (
      specifier.startsWith("@rada/") &&
      !["@rada/ui", "@rada/ui/design-system.css"].includes(specifier) &&
      !/^@rada\/ui\/screens\/[a-z0-9-]+\.css$/.test(specifier)
    )
      errors.push(
        `${path}: use explicit module index.ts paths instead of aliases`,
      );
  }
  /** @param {import('typescript').Node} node */
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    )
      inspect(node.moduleSpecifier);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      inspect(node.moduleReference.expression);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments[0]
    )
      inspect(node.arguments[0]);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      inspect(node.argument.literal);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return errors;
}

/** Remove comments while preserving quoted identifiers and function bodies.
 * @param {string} sql
 */
function withoutSqlComments(sql) {
  return sql.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\//g,
    (part) => (part.startsWith("--") || part.startsWith("/*") ? " " : part),
  );
}

/** @param {string} source @param {boolean} typescript */
function sqlFragments(source, typescript) {
  if (!typescript) return [source];
  const tree = ts.createSourceFile(
    "module.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  /** @type {string[]} */
  const fragments = [];
  /** @param {import('typescript').Node} node */
  function visit(node) {
    if (ts.isStringLiteralLike(node)) fragments.push(node.text);
    if (ts.isTemplateExpression(node)) {
      fragments.push(
        node.head.text +
          node.templateSpans.map((span) => ` ? ${span.literal.text}`).join(""),
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return fragments;
}

/** @param {string} path @param {string} source */
export function moduleSqlViolations(path, source, publicViews = new Set()) {
  const owner = /^modules\/([^/]+)\//.exec(path)?.[1];
  if (
    (!owner && !path.startsWith("apps/")) ||
    isTest(path) ||
    !/\.(?:sql|[cm]?[jt]s)$/.test(path)
  )
    return [];
  const historical = historicalMigrations.get(path);
  if (historical) {
    return createHash("sha256").update(source).digest("hex") === historical
      ? []
      : [`${path}: historical migration SQL is immutable`];
  }
  /** @type {string[]} */
  const errors = [];
  for (const fragment of sqlFragments(source, !path.endsWith(".sql"))) {
    const sql = withoutSqlComments(fragment);
    // A qualified function call is a public SQL interface; a qualified relation is not.
    const references =
      /\b(?:from|join|update|into|references|on(?:\s+table)?|truncate(?:\s+table)?|alter\s+table|create\s+table(?:\s+if\s+not\s+exists)?|delete\s+from)\s+(?:only\s+)?("?[a-z_][a-z0-9_]*"?)\s*\.\s*("?[a-z_][a-z0-9_]*"?)/gi;
    for (const match of sql.matchAll(references)) {
      const schema = (match[1] ?? "").replaceAll('"', "").toLowerCase();
      if (
        schema === owner ||
        publicViews.has(
          `${schema}.${(match[2] ?? "").replaceAll('"', "").toLowerCase()}`,
        ) ||
        (/^(?:from|join)\b/i.test(match[0]) &&
          /^\s*\(/.test(sql.slice(match.index + match[0].length)))
      )
        continue;
      errors.push(
        `${path}: direct ${schema} relation access; use its public SQL function or view`,
      );
    }
  }
  return errors;
}

/** @param {string} path @param {string} source */
export function architectureViolations(path, source, publicViews = new Set()) {
  return [
    ...codeSizeViolations(path, source),
    ...parameterPropertyViolations(path, source),
    ...designSystemViolations(path, source),
    ...moduleImportViolations(path, source),
    ...moduleSqlViolations(path, source, publicViews),
  ];
}

/** A module can publish its own declared SQL views through its index contract.
 * @param {Map<string, string>} sources
 */
export function publicSqlViews(sources) {
  /** @type {Set<string>} */
  const views = new Set();
  for (const [path, source] of sources) {
    const owner = /^modules\/([^/]+)\/index\.ts$/.exec(path)?.[1];
    if (!owner) continue;
    const tree = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of tree.statements) {
      if (
        !ts.isVariableStatement(statement) ||
        !statement.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword,
        )
      )
        continue;
      for (const declaration of statement.declarationList.declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          declaration.name.text !== "SQL_PUBLIC_VIEWS"
        )
          continue;
        let value = declaration.initializer;
        if (value && ts.isAsExpression(value)) value = value.expression;
        if (!value || !ts.isArrayLiteralExpression(value))
          throw new Error(`${path}: SQL_PUBLIC_VIEWS must be a literal array`);
        for (const entry of value.elements) {
          if (
            !ts.isStringLiteralLike(entry) ||
            !new RegExp(`^${owner}\\.[a-z_][a-z0-9_]*$`).test(entry.text)
          )
            throw new Error(
              `${path}: public SQL views must belong to their module`,
            );
          const definition = new RegExp(
            `\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+${entry.text.replace(".", "\\.")}\\b`,
            "i",
          );
          const declared = [...sources].some(
            ([sqlPath, sql]) =>
              sqlPath.startsWith(`modules/${owner}/db/`) &&
              sqlPath.endsWith(".sql") &&
              !isTest(sqlPath) &&
              definition.test(withoutSqlComments(sql)),
          );
          if (!declared)
            throw new Error(
              `${path}: ${entry.text} has no owned view definition`,
            );
          views.add(entry.text);
        }
      }
    }
  }
  return views;
}

/** @param {Iterable<string>} files */
export function missingHistoricalMigrations(files) {
  const paths = new Set(files);
  return [...historicalMigrations.keys()]
    .filter((path) => !paths.has(path))
    .map((path) => `Missing historical migration: ${path}`);
}
