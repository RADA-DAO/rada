import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const metrics = [
  "initialJsGzip",
  "initialJsBrotli",
  "initialCss",
  "fonts",
  "lazyJsGzip",
  "lazyJsBrotli",
  "lazyCss",
];
/** @typedef {{file: string, isEntry?: boolean, imports?: string[], dynamicImports?: string[], css?: string[]}} Chunk */
/** @typedef {Record<string, number>} Sizes */

/** Sum individually compressed files, matching separate HTTP responses.
 * @param {Set<string>} files @param {(file: string) => Buffer} read
 */
function sizes(files, read) {
  const result = { raw: 0, gzip: 0, brotli: 0 };
  for (const file of files) {
    const data = read(file);
    result.raw += data.length;
    result.gzip += gzipSync(data, { level: 9 }).length;
    result.brotli += brotliCompressSync(data).length;
  }
  return result;
}

/** @param {Record<string, Chunk>} manifest @param {(file: string) => Buffer} read
 * @param {string[]} fonts All emitted fonts, including public assets (conservative per entry).
 */
export function measure(manifest, read, fonts = []) {
  /** @type {Record<string, Sizes>} */
  const entries = {};
  /** @type {{entry: string, file: string, raw: number, gzip: number, brotli: number}[]} */
  const lazyChunks = [];
  /** @param {string} key */
  function chunk(key) {
    const value = manifest[key];
    if (!value) throw new Error(`Missing manifest import: ${key}`);
    return value;
  }
  /** @param {string} key @param {Set<string>} found @param {boolean} dynamic */
  function visit(key, found, dynamic) {
    if (found.has(key)) return;
    found.add(key);
    const value = chunk(key);
    for (const dependency of value.imports ?? [])
      visit(dependency, found, dynamic);
    if (dynamic)
      for (const dependency of value.dynamicImports ?? [])
        visit(dependency, found, true);
  }
  /** @param {Set<string>} keys @param {boolean} css */
  function files(keys, css) {
    return new Set(
      [...keys].flatMap((key) =>
        css ? (chunk(key).css ?? []) : [chunk(key).file],
      ),
    );
  }
  for (const [key, value] of Object.entries(manifest)) {
    if (!value.isEntry) continue;
    /** @type {Set<string>} */
    const initial = new Set();
    /** @type {Set<string>} */
    const reachable = new Set();
    visit(key, initial, false);
    visit(key, reachable, true);
    const lazy = new Set([...reachable].filter((id) => !initial.has(id)));
    const initialJs = sizes(files(initial, false), read);
    const lazyJs = sizes(files(lazy, false), read);
    const initialCss = files(initial, true);
    const lazyCss = new Set(
      [...files(lazy, true)].filter((file) => !initialCss.has(file)),
    );
    entries[key] = {
      initialJsGzip: initialJs.gzip,
      initialJsBrotli: initialJs.brotli,
      initialCss: sizes(initialCss, read).raw,
      fonts: sizes(new Set(fonts), read).raw,
      lazyJsGzip: lazyJs.gzip,
      lazyJsBrotli: lazyJs.brotli,
      lazyCss: sizes(lazyCss, read).raw,
    };
    for (const file of files(lazy, false))
      lazyChunks.push({ entry: key, file, ...sizes(new Set([file]), read) });
  }
  if (!Object.keys(entries).length)
    throw new Error("No production entries in manifest");
  return { entries, lazyChunks };
}

/** Fail closed on new/missing entries, missing metrics and invalid limits.
 * @param {Record<string, Sizes>} actual @param {unknown} budget
 */
export function compare(actual, budget) {
  if (!budget || typeof budget !== "object" || Array.isArray(budget))
    throw new Error("Budget must be an object keyed by entry");
  /** @type {{entry: string, metric: string, actual: number, limit: unknown, status: string}[]} */
  const rows = [];
  for (const entry of new Set([
    ...Object.keys(actual),
    ...Object.keys(budget),
  ])) {
    /** @type {unknown} */
    const rawLimits = Object.getOwnPropertyDescriptor(budget, entry)?.value;
    const limits = /** @type {Record<string, unknown> | undefined} */ (
      rawLimits
    );
    if (!actual[entry]) {
      rows.push({
        entry,
        metric: "entry",
        actual: 0,
        limit: "-",
        status: "MISSING ENTRY",
      });
      continue;
    }
    for (const metric of metrics) {
      const value = actual[entry][metric];
      const limit = limits?.[metric];
      const valid =
        typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0;
      rows.push({
        entry,
        metric,
        actual: value ?? NaN,
        limit: limit ?? "-",
        status: !valid
          ? "INVALID BUDGET"
          : !Number.isFinite(value) || value === undefined || value > limit
            ? "OVER"
            : "PASS",
      });
    }
  }
  return {
    rows,
    passed: rows.length > 0 && rows.every((row) => row.status === "PASS"),
  };
}

/** @param {string} directory @returns {string[]} */
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(resolve(directory, entry.name))
      : [resolve(directory, entry.name)],
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--skip-build"))
    throw new Error("Usage: node tools/bundle-budget.mjs [--skip-build]");
  if (
    process.env.CATALOG === "true" ||
    process.env.E2E_TONCONNECT_MOCK === "true"
  )
    throw new Error(
      "Bundle budgets require a production build without catalog or mocks",
    );
  if (!args.includes("--skip-build"))
    execFileSync("npm", ["run", "build:miniapp"], {
      cwd: root,
      stdio: "inherit",
    });
  const dist = resolve(root, "apps/miniapp/dist");
  /** @type {unknown} */
  const rawManifest = JSON.parse(
    readFileSync(resolve(dist, ".vite/manifest.json"), "utf8"),
  );
  const manifest = /** @type {Record<string, Chunk>} */ (rawManifest);
  const fonts = walk(dist).filter((file) =>
    /\.(woff2?|ttf|otf|eot)$/i.test(file),
  );
  const report = measure(
    manifest,
    (file) => readFileSync(resolve(dist, file)),
    fonts,
  );
  /** @type {unknown} */
  const budget = JSON.parse(
    readFileSync(resolve(root, "tools/miniapp-budget.json"), "utf8"),
  );
  const result = compare(report.entries, budget);
  console.log(
    "Production miniapp budget (bytes; CSS/fonts raw; JS gzip level 9 / Brotli default)",
  );
  console.table(result.rows);
  if (report.lazyChunks.length) {
    console.log("Lazy JS chunks (included in per-entry lazy totals above)");
    console.table(report.lazyChunks);
  }
  if (!result.passed) {
    console.error(
      "Miniapp budget failed. Review the change and docs/contributing before raising limits.",
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
