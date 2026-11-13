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
  const keyboardSource = (
    await readFile(new URL("../src/keyboard.ts", import.meta.url), "utf8")
  )
    .replace(/^import "\.\/keyboard\.css";\s*/m, "")
    .replace(/^export /gm, "");
  const keyboard = ts.transpileModule(keyboardSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  const styles = (
    await Promise.all(
      [
        "../../ui/src/primitives.css",
        "../../ui/src/components.css",
        "../../ui/src/community.css",
        "../src/keyboard.css",
      ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
    )
  ).join("\n");
  if (/@import|url\s*\(/i.test(styles))
    throw new Error("Community styles must be self-contained");
  const markup = await readFile(new URL("view.html", source), "utf8");
  const script = `${keyboard}\nconst translations=${JSON.stringify(translations)};const revision=${String(revision)};\n${client}`;
  const html = `${markup}<style>${styles}</style><script>${script.replace(/<\/script/gi, "<\\/script")}</script>`;
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
