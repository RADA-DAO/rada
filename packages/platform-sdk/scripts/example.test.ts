import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExample } from "./build-example.ts";
import { localApiOrigin, syntheticLaunch } from "./example-lifecycle.ts";
import { verifyAppArtifact } from "../src/app-artifact.ts";

void test("SDK example emits deterministic, immutable verified releases with no protected permissions", async () => {
  const output = await mkdtemp(join(tmpdir(), "rada-sdk-example-"));
  try {
    const first = await buildExample(output, 1);
    const same = await buildExample(output, 1);
    const second = await buildExample(output, 2);
    assert.equal(first.sha256, same.sha256);
    assert.notEqual(first.sha256, second.sha256);
    assert.deepEqual(first.manifest.permissions, ["navigation"]);
    const html = await readFile(first.artifactPath, "utf8");
    assert.equal(
      await verifyAppArtifact(new Response(html), first.sha256),
      html,
    );
    assert.match(html, /rada\.member\.context\.get/);
    assert.doesNotMatch(
      html,
      /synthetic-fixture-bot-token|initData|Authorization/,
    );
    await assert.rejects(
      verifyAppArtifact(new Response(html + "changed"), first.sha256),
      /artifact_integrity_failed/,
    );
    await writeFile(first.artifactPath, "changed");
    await assert.rejects(buildExample(output, 1), /immutable artifact/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

void test("lifecycle cannot target a remote or ambiguous API origin", () => {
  assert.equal(
    localApiOrigin("http://127.0.0.1:8000"),
    "http://127.0.0.1:8000",
  );
  for (const origin of [
    "https://api.example",
    "http://127.0.0.1:8000/",
    "http://user:password@127.0.0.1:8000",
    "file:///tmp/api",
    "http://127.0.0.1:8000/api",
  ])
    assert.throws(() => localApiOrigin(origin));
  const launch = new URLSearchParams(syntheticLaunch());
  assert.equal(launch.get("user"), '{"id":101}');
  assert.match(launch.get("hash") ?? "", /^[a-f0-9]{64}$/);
});
