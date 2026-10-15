import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const modules = fileURLToPath(new URL("../modules/", import.meta.url));
/** Discover owned directories deterministically; applied order is global version order. */
export function moduleDirectories() {
  return readdirSync(modules, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(modules, entry.name))
    .sort();
}
/** @param {string} [directory] Optional flat source for isolated migration fixtures. */
export function discoverMigrations(directory) {
  const directories = directory
    ? [resolve(directory)]
    : moduleDirectories().map((path) => resolve(path, "db/migrations"));
  const files = directories
    .flatMap((path) =>
      readdirSync(path)
        .filter((name) => name.endsWith(".sql"))
        .map((name) => ({ name, path: resolve(path, name) })),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  const names = files.map(({ name }) => name);
  if (
    !names.length ||
    names.some((name) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) ||
    new Set(names.map((name) => name.slice(0, 4))).size !== names.length
  ) {
    throw new Error(
      "Migrations require unique four-digit versions and SQL files",
    );
  }
  return files.map(({ name, path }) => {
    const sql = readFileSync(path, "utf8");
    return {
      name,
      path,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    };
  });
}
