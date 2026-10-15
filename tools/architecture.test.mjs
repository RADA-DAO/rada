import test from "node:test";
import assert from "node:assert/strict";
import {
  codeSizeViolations,
  moduleImportViolations,
  moduleSqlViolations,
  missingHistoricalMigrations,
  publicSqlViews,
} from "./architecture.mjs";

test("code size gate covers executable files and only exempts test/generated paths", () => {
  const lines = "statement;\n".repeat(401);
  assert.equal(
    codeSizeViolations("modules/apps/api/store.ts", lines).length,
    1,
  );
  assert.equal(codeSizeViolations("apps/miniapp/src/main.ts", lines).length, 1);
  assert.equal(
    codeSizeViolations("apps/miniapp/src/main.ts", "x\n".repeat(400)).length,
    0,
  );
  for (const path of [
    "tools/check.test.mjs",
    "modules/apps/db/apps.test.sql",
    "packages/ui/scripts/test-theme.ts",
    "modules/apps/generated/client.ts",
  ])
    assert.deepEqual(codeSizeViolations(path, lines), []);
  assert.equal(
    codeSizeViolations("modules/apps/api/client.ts", "// generated\n" + lines)
      .length,
    1,
  );
});

test("foreign views require an owned definition exported by the module index", () => {
  const sources = new Map([
    [
      "modules/identity/index.ts",
      'export const SQL_PUBLIC_VIEWS = ["identity.public_profile"] as const;',
    ],
    [
      "modules/identity/db/migrations/0004_view.sql",
      "CREATE VIEW identity.public_profile AS SELECT subject_id FROM identity.subjects;",
    ],
  ]);
  const views = publicSqlViews(sources);
  assert.deepEqual(
    moduleSqlViolations(
      "modules/apps/db/new.sql",
      "SELECT * FROM identity.public_profile",
      views,
    ),
    [],
  );
  assert.ok(
    moduleSqlViolations(
      "modules/apps/db/new.sql",
      "SELECT * FROM identity.subjects",
      views,
    ).length,
  );
  sources.delete("modules/identity/db/migrations/0004_view.sql");
  assert.throws(() => publicSqlViews(sources), /no owned view definition/);
  sources.set(
    "modules/identity/index.ts",
    'export const SQL_PUBLIC_VIEWS = ["apps.registry"] as const;',
  );
  assert.throws(() => publicSqlViews(sources), /belong to their module/);
});

test("cross-module imports require public index for static, re-export and dynamic paths", () => {
  for (const source of [
    'import { x } from "../../jpegpe/api/store.ts";',
    'export { x } from "../../jpegpe/api/store.ts";',
    'const x = import("../../jpegpe/api/store.ts");',
    'const x = require("../../jpegpe/api/store.ts");',
    'type X = import("../../jpegpe/api/store.ts").X;',
    'import x = require("../../jpegpe/api/store.ts");',
    "const x = import(variable);",
  ])
    assert.ok(
      moduleImportViolations("modules/identity/api/store.ts", source).length,
      source,
    );
  assert.ok(
    moduleImportViolations(
      "apps/api/src/app.ts",
      'import "../../../modules/identity/api/store.ts";',
    ).length,
  );
  for (const source of [
    'import { x } from "../../jpegpe/index.ts";',
    'import { x } from "./private.ts";',
    'import pg from "pg";',
  ])
    assert.deepEqual(
      moduleImportViolations("modules/identity/api/store.ts", source),
      [],
    );
  assert.ok(
    moduleImportViolations(
      "modules/identity/api/store.ts",
      'import x from "@rada/jpegpe/private";',
    ).length,
  );
});

test("SQL boundary rejects foreign table queries including quoted names and embedded SQL", () => {
  assert.ok(
    moduleSqlViolations(
      "apps/api/src/app.ts",
      'const q = "SELECT * FROM identity.subjects";',
    ).length,
  );
  assert.ok(
    moduleImportViolations(
      "modules/identity/api/router.ts",
      'import "../../../apps/api/src/app.ts";',
    ).length,
  );
  for (const sql of [
    "SELECT * FROM identity.subjects",
    'UPDATE "identity"."subjects" SET selected_frog_id = NULL',
    "INSERT INTO identity.subjects SELECT * FROM apps.registry",
    "DELETE FROM identity.consents",
    "SELECT * FROM apps.registry JOIN identity.subjects USING(subject_id)",
    "TRUNCATE TABLE identity.subjects",
    "GRANT SELECT ON identity.subjects TO apps_service",
    "CREATE INDEX foreign_lookup ON identity.subjects(subject_id)",
    "CREATE TABLE apps.links(subject_id uuid REFERENCES identity.subjects(subject_id))",
  ])
    assert.ok(moduleSqlViolations("modules/apps/db/new.sql", sql).length, sql);
  assert.ok(
    moduleSqlViolations(
      "modules/apps/api/store.ts",
      "const query = `SELECT * FROM identity.subjects WHERE subject_id = ${id}`;",
    ).length,
  );
  assert.deepEqual(
    moduleSqlViolations(
      "modules/apps/db/new.sql",
      "SELECT apps.published(); SELECT * FROM identity.public_profile($1); -- FROM identity.subjects\n SELECT * FROM apps.registry;",
    ),
    [],
  );
  assert.deepEqual(
    moduleSqlViolations(
      "modules/apps/db/apps.test.sql",
      "SELECT * FROM identity.subjects",
    ),
    [],
  );
  assert.ok(
    moduleSqlViolations(
      "modules/identity/db/migrations/0001_identity.sql",
      "changed",
    ).length,
  );
  assert.equal(missingHistoricalMigrations([]).length, 3);
});
