import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parseAppManifest } from "../src/app-manifest.ts";

const source = new URL("../examples/hello-community/", import.meta.url);

/** No credentials, remote dependencies or non-reviewed permission grants. */
export async function buildExample(outputRoot: string, revision: 1 | 2 = 1) {
  const manifest = parseAppManifest(
    JSON.parse(await readFile(new URL("rada.app.json", source), "utf8")),
  );
  const translations: Record<string, unknown> = Object.fromEntries(
    await Promise.all(
      ["en", "uk"].map(async (locale): Promise<readonly [string, unknown]> => [
        locale,
        JSON.parse(
          await readFile(new URL(`locales/${locale}.json`, source), "utf8"),
        ) as unknown,
      ]),
    ),
  );
  const client = ts.transpileModule(
    await readFile(new URL("client.ts", source), "utf8"),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    },
  ).outputText;
  const script = `const translations=${JSON.stringify(translations)};const revision=${String(revision)};\n${client}`;
  const html = `<main><h1 data-copy="title"></h1><p data-copy="description"></p><p id="release"></p><output id="count" aria-live="polite"></output><nav><button id="increment" data-copy="increment"></button><button id="back" data-copy="back"></button></nav></main><style>body{margin:0;font:16px system-ui;background:#eff8f5;color:#153e35}main{box-sizing:border-box;max-width:38rem;margin:auto;padding:24px}h1{font-size:1.75rem}p{line-height:1.5}output{display:block;margin:24px 0;font-variant-numeric:tabular-nums}nav{display:flex;flex-wrap:wrap;gap:12px}button{font:inherit;min-height:44px;padding:10px 16px;border:1px solid currentColor;border-radius:12px;background:transparent;color:inherit}button:focus-visible{outline:3px solid #22755c;outline-offset:3px}</style><script>${script.replace(/<\/script/gi, "<\\/script")}</script>`;
  const bytes = Buffer.from(html, "utf8");
  if (bytes.length > 1024 * 1024)
    throw new Error("Example artifact exceeds host budget");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = resolve(outputRoot, "artifacts");
  await mkdir(directory, { recursive: true });
  const artifactPath = resolve(directory, `${sha256}.html`);
  try {
    await writeFile(artifactPath, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await readFile(artifactPath)).equals(bytes))
      throw new Error("Existing immutable artifact does not match its hash", {
        cause: error,
      });
  }
  return { manifest, sha256, artifactPath, revision };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const output = process.argv[2];
  const revision = process.argv[3] ?? "1";
  if (!output || !["1", "2"].includes(revision))
    throw new Error(
      "Usage: node packages/platform-sdk/scripts/build-example.ts OUTPUT_DIR [1|2]",
    );
  const artifact = await buildExample(output, revision === "2" ? 2 : 1);
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}
