import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRaidCapture,
  privateAliases,
  allowKnownRaidSubset,
} from "./raid-shadow-input.ts";
void test("same-length capture corruption blocks before source epoch or database access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raid-capture-test-"));
  try {
    await writeFile(join(directory, "rules.json"), "{}");
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        stable: true,
        files: {
          rules: {
            capture: "rules.json",
            bytes: 2,
            sha256: createHash("sha256").update("[]").digest("hex"),
          },
        },
      }),
    );
    await assert.rejects(loadRaidCapture(directory), /capture_hash_mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
void test("manifest path escape is rejected before reading a parent file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raid-capture-test-"));
  try {
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        stable: true,
        files: {
          rules: { capture: "../escape.json", bytes: 0, sha256: "unused" },
        },
      }),
    );
    await assert.rejects(loadRaidCapture(directory), /capture_path_escape/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
void test("ephemeral actor aliases are stable within a run and isolate actors and key scopes", () => {
  const aliases = privateAliases();
  assert.equal(aliases.actor(1), aliases.actor(1));
  assert.notEqual(aliases.actor(1), aliases.actor(2));
  assert.match(aliases.actor(1), /^[1-9]\d+$/);
  assert.notEqual(
    aliases.opaque("source", "same"),
    aliases.opaque("evidence", "same"),
  );
});

void test("known raid SQL subset permits only coverage gaps while context and every served leaf stay exact", () => {
  assert.equal(allowKnownRaidSubset({ problems: [], differences: [] }), true);
  assert.equal(
    allowKnownRaidSubset({ problems: ["blocked_raw_source"], differences: [] }),
    true,
  );
  assert.equal(
    allowKnownRaidSubset({
      problems: ["source_context_mismatch"],
      differences: [],
    }),
    false,
  );
  assert.equal(
    allowKnownRaidSubset({
      problems: ["blocked_raw_source", "source_context_mismatch"],
      differences: [],
    }),
    false,
  );
  assert.equal(
    allowKnownRaidSubset({
      problems: ["blocked_raw_source"],
      differences: ["opaque-leaf-difference"],
    }),
    false,
  );
  assert.equal(
    allowKnownRaidSubset({
      problems: [],
      differences: ["opaque-leaf-difference"],
    }),
    false,
  );
  assert.equal(
    allowKnownRaidSubset({
      problems: ["duplicate_served_raid_key"],
      differences: [],
    }),
    false,
  );
});
