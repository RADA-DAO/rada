import ts from "typescript";

const publicStylesheet = "@rada/ui/design-system.css";
const rawColor =
  /(?:^|[\s,(])(?:#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\da-f])|(?:rgb|hsl)a?\s*\()/i;
const rawDimension = /(?:^|[\s,(])-?(?:\d*\.)?\d+(?:px|rem|em)\b/i;
const dimensionProperty =
  /^(?:font(?:Size)?|lineHeight|letterSpacing|(?:margin|padding)(?:Top|Right|Bottom|Left|Inline|Block|InlineStart|InlineEnd|BlockStart|BlockEnd)?|(?:row|column)?Gap|gap)$/i;
const visualProperty =
  /^(?:color|background(?:Color|Image)?|border\w*|outline\w*|boxShadow|textShadow|fill|stroke)$/i;
const paletteProperty = /^(?:color|background(?:Color|-color)?|fill|stroke)$/i;
const semanticColor =
  /^(?:var\([\s\S]+\)|transparent|currentColor|inherit|initial|unset|none)$/i;
const gesture = /^(?:on)?(?:touchstart|pointerdown|swipe\w*)$/i;

/** @param {import('typescript').Node | undefined} node @returns {string | undefined} */
function literal(node) {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return literal(node.expression);
  return undefined;
}

/** @param {import('typescript').Node} node @returns {string[]} */
function members(node) {
  if (ts.isPropertyAccessExpression(node))
    return [...members(node.expression), node.name.text];
  if (ts.isElementAccessExpression(node))
    return [
      ...members(node.expression),
      literal(node.argumentExpression) ?? "?",
    ];
  return ts.isIdentifier(node) ? [node.text] : [];
}

/** @param {string} path @param {string} source */
export function designSystemViolations(path, source) {
  if (
    !/^(?:apps|modules)\//.test(path) ||
    /(?:^|\/)(?:tests?|fixtures|generated)(?:\/|\.)|\.(?:test|spec)\.|(?:^|\/)test-[^/]+\.[cm]?[jt]s$/.test(
      path,
    )
  )
    return [];
  /** @type {Set<string>} */
  const issues = new Set();
  /** @param {string} message */
  const report = (message) => issues.add(`${path}: ${message}`);
  if (/\.(?:css|scss|sass|less)$/.test(path)) {
    report("local CSS is owned by @rada/ui; use its public design-system.css");
    return [...issues];
  }
  /** Inspect markup only in HTML documents or actual rendering sinks.
   * @param {string} html
   */
  function inspectHtml(html) {
    // Strip until stable so overlapping fragments cannot reassemble a tag.
    let markup = html;
    for (let previous = ""; previous !== markup;) {
      previous = markup;
      markup = markup.replace(
        /<!--[\s\S]*?--!?>|<script\b[\s\S]*?<\/script\b[^>]*>/gi,
        "",
      );
    }
    for (const match of markup.matchAll(/<[a-z][^>]*>/gi)) {
      const tag = match[0];
      if (/^<style\b|\sstyle\s*=/i.test(tag))
        report("local style injection is owned by @rada/ui");
      if (/\son(?:touchstart|pointerdown|swipe\w*)\s*=/i.test(tag))
        report("gesture handlers are owned by the platform SDK");
      if (/^<link\b/i.test(tag) && /\brel\s*=\s*["']stylesheet["']/i.test(tag))
        report("HTML stylesheet links must use the public @rada/ui import");
    }
    for (const script of html.matchAll(
      /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi,
    )) {
      const type =
        /\btype\s*=\s*["']([^"']*)["']/i.exec(script[1] ?? "")?.[1] ?? "";
      if (
        type &&
        !/^(?:module|(?:text|application)\/(?:java|ecma)script)$/i.test(type)
      )
        continue;
      for (const issue of designSystemViolations(
        `${path}.inline.ts`,
        script[2] ?? "",
      ))
        issues.add(issue.replace(`${path}.inline.ts:`, `${path}:`));
    }
  }
  if (/\.html$/.test(path)) {
    inspectHtml(source);
    return [...issues];
  }
  if (!/\.[cm]?[jt]sx?$/.test(path)) return [];
  const tree = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    /[jt]sx$/.test(path) ? ts.ScriptKind.TSX : undefined,
  );
  /** @param {import('typescript').Node} argument */
  function inspectImport(argument) {
    if (!ts.isStringLiteralLike(argument)) return;
    if (
      (/\.(?:css|scss|sass|less)(?:[?#]|$)/i.test(argument.text) ||
        /^data:text\/css/i.test(argument.text)) &&
      argument.text !== publicStylesheet
    )
      report("CSS imports must use @rada/ui/design-system.css exactly");
  }
  /** @param {import('typescript').Node} node */
  function styleObject(node) {
    for (
      let parent = node.parent;
      !ts.isSourceFile(parent);
      parent = parent.parent
    ) {
      if (ts.isJsxAttribute(parent))
        return parent.name.getText(tree) === "style";
      if (ts.isVariableDeclaration(parent))
        return /styles?|css/i.test(literal(parent.name) ?? "");
      if (ts.isPropertyAssignment(parent) && literal(parent.name) === "style")
        return true;
      if (ts.isStatement(parent)) break;
    }
    return false;
  }
  /** @param {string} property @param {import('typescript').Node | undefined} value */
  function inspectPalette(property, value) {
    if (
      paletteProperty.test(property) &&
      value &&
      ts.isStringLiteralLike(value) &&
      !semanticColor.test(value.text)
    )
      report("palette style values must use @rada/ui tokens");
  }
  /** @param {import('typescript').Node} node */
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    )
      inspectImport(node.moduleSpecifier);
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      inspectImport(node.moduleReference.expression);
    if (ts.isCallExpression(node)) {
      const chain = members(node.expression);
      const method = chain.at(-1);
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          method === "require") &&
        node.arguments[0]
      )
        inspectImport(node.arguments[0]);
      if (
        method === "back" &&
        chain.at(-2) === "history" &&
        (chain.length === 2 ||
          ["window", "globalThis", "self"].includes(chain[0] ?? ""))
      )
        report("history.back() is owned by the platform SDK");
      if (
        method === "addEventListener" &&
        gesture.test(literal(node.arguments[0]) ?? "")
      )
        report("gesture handlers are owned by the platform SDK");
      if (method === "insertAdjacentHTML" && node.arguments[1]) {
        const html = node.arguments[1];
        if (ts.isStringLiteralLike(html)) inspectHtml(html.text);
        if (ts.isTemplateExpression(html))
          inspectHtml(
            html.head.text +
              html.templateSpans
                .map((span) => `?${span.literal.text}`)
                .join(""),
          );
      }
      if (method === "setAttribute") {
        const attribute = literal(node.arguments[0]) ?? "";
        if (gesture.test(attribute))
          report("gesture handlers are owned by the platform SDK");
        if (attribute === "style")
          report("local style injection is owned by @rada/ui");
      }
      if (
        (method === "createElement" &&
          literal(node.arguments[0]) === "style") ||
        ["insertRule", "replaceSync", "addRule"].includes(method ?? "") ||
        (method === "replace" && chain.includes("sheet"))
      )
        report("local style injection is owned by @rada/ui");
      if (method === "setProperty" && chain.includes("style")) {
        const property = literal(node.arguments[0]) ?? "";
        inspectPalette(property, node.arguments[1]);
        const value = literal(node.arguments[1]) ?? "";
        if (
          (rawColor.test(value) || rawDimension.test(value)) &&
          !property.startsWith("--")
        )
          report("raw style values must use @rada/ui tokens");
        if (property.startsWith("--"))
          report("design tokens are declared only in @rada/ui");
      }
    }
    if (
      ts.isNewExpression(node) &&
      literal(node.expression) === "CSSStyleSheet"
    )
      report("local style injection is owned by @rada/ui");
    if (
      ts.isTaggedTemplateExpression(node) &&
      /(?:css|styled)/i.test(members(node.tag).join("."))
    )
      report("local CSS declarations are owned by @rada/ui");
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(tree);
      if (gesture.test(name))
        report("gesture handlers are owned by the platform SDK");
      if (
        name === "style" &&
        node.initializer &&
        ts.isStringLiteral(node.initializer)
      )
        report("local style injection is owned by @rada/ui");
    }
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(tree) === "style"
    )
      report("local style injection is owned by @rada/ui");
    if (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) {
      const name = literal(node.name) ?? "";
      if (ts.isPropertyAssignment(node) && styleObject(node))
        inspectPalette(name, node.initializer);
      if (gesture.test(name))
        report("gesture handlers are owned by the platform SDK");
      if (
        ts.isPropertyAssignment(node) &&
        dimensionProperty.test(name) &&
        ts.isNumericLiteral(node.initializer) &&
        node.initializer.text !== "0"
      )
        report("font and spacing constants must use @rada/ui tokens");
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const chain = members(node.left);
      const property = chain.at(-1) ?? "";
      if (chain.includes("style")) inspectPalette(property, node.right);
      if (["innerHTML", "outerHTML"].includes(property)) {
        if (ts.isStringLiteralLike(node.right)) inspectHtml(node.right.text);
        if (ts.isTemplateExpression(node.right))
          inspectHtml(
            node.right.head.text +
              node.right.templateSpans
                .map((span) => `?${span.literal.text}`)
                .join(""),
          );
      }
      if (gesture.test(property))
        report("gesture handlers are owned by the platform SDK");
      if (
        chain.includes("style") &&
        (property === "cssText" || property.startsWith("--"))
      )
        report("local style injection is owned by @rada/ui");
      if (
        chain.includes("style") &&
        dimensionProperty.test(property) &&
        ts.isNumericLiteral(node.right) &&
        node.right.text !== "0"
      )
        report("font and spacing constants must use @rada/ui tokens");
    }
    if (ts.isTemplateExpression(node)) {
      const css =
        node.head.text +
        node.templateSpans.map((span) => `?${span.literal.text}`).join("");
      if (
        /^\s*(?:[^{}]+\{[^{}]*|(?:background|color|font|padding|margin)[\w-]*)\s*:/i.test(
          css,
        ) ||
        /<style\b/i.test(css)
      )
        report("local CSS declarations are owned by @rada/ui");
      if (
        rawColor.test(css) &&
        /^(?:var\(|#|(?:rgb|hsl)a?\s*\(|linear-gradient)/i.test(css)
      )
        report("raw colors must use @rada/ui tokens");
      if (
        rawDimension.test(css) &&
        /^(?:-?[\d.]|calc\(|var\(|translate|scale|rotate)/i.test(css)
      )
        report("raw dimensions must use @rada/ui tokens");
    }
    if (ts.isStringLiteralLike(node)) {
      const parent = node.parent;
      const styleValue =
        (ts.isPropertyAssignment(parent) &&
          visualProperty.test(literal(parent.name) ?? "")) ||
        (ts.isBinaryExpression(parent) &&
          members(parent.left).includes("style"));
      if (styleValue && rawColor.test(node.text))
        report("raw colors must use @rada/ui tokens");
      if (
        /^\s*[^{}]+\{[^{}]*[a-z-]+\s*:|^\s*@import\s|<style\b/i.test(node.text)
      )
        report("local CSS declarations are owned by @rada/ui");
      // Inspect actual value literals, not comments, URL fragments, SQL, or protocol identifiers.
      if (
        rawColor.test(node.text) &&
        /^(?:var\(|#[\da-f]{3,8}|(?:rgb|hsl)a?\s*\(|(?:[\d.]+(?:px|rem|em)|solid|linear-gradient)\b)/i.test(
          node.text,
        )
      )
        report("raw colors must use @rada/ui tokens");
      if (
        rawDimension.test(node.text) &&
        /^(?:-?[\d.]|calc\(|var\(|translate|scale|rotate)/i.test(node.text)
      )
        report("raw dimensions must use @rada/ui tokens");
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return [...issues];
}
