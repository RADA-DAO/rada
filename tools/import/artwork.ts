import type { Client } from "pg";
import {
  PostgresImageStorage,
  type ArtworkImage,
} from "../../modules/jpegpe/storage.ts";
import {
  digest,
  prepareArtwork,
  readManifest,
  readJournal,
  InvalidArtwork,
  type ManifestObject,
} from "./artwork-files.ts";
import { hash, type Snapshot, type Conflict } from "./model.ts";
import type { Mode } from "./runner.ts";
const system = "FAIRGROUND_ARTWORK";
const sourceTable = "public.jpegpe_frog_submissions.storage_path";
interface Record {
  id: string;
  key: string;
  image: ArtworkImage;
  value: unknown;
}
export interface ArtworkPlan {
  records: Record[];
  conflicts: Conflict[];
  total: number;
}
const imageState = (image: ArtworkImage) => ({
  sha256: digest(image.bytes),
  contentType: image.contentType,
  needsNormalization: image.needsNormalization,
});
export async function planArtwork(
  source: Client,
  snapshot: Snapshot,
  root: string,
  manifest?: string,
  journal?: string,
  blobs?: string,
): Promise<ArtworkPlan> {
  if (Boolean(journal) !== Boolean(blobs))
    throw new Error("Both journal settings required");
  const objects = manifest
    ? await readManifest(manifest)
    : new Map<string, ManifestObject>();
  if (journal) await readJournal(journal, objects);
  const rows = (
    await source.query<{ id: string; storage_path: string | null }>(
      "SELECT id::text, storage_path FROM public.jpegpe_frog_submissions ORDER BY id",
    )
  ).rows;
  const eligible = new Set(
    snapshot.records.filter((r) => r.entity === "frogs").map((r) => r.id),
  );
  const plan: ArtworkPlan = { records: [], conflicts: [], total: 0 };
  for (const row of rows) {
    if (!eligible.has(row.id)) continue;
    plan.total++;
    try {
      if (!row.storage_path) throw new Error("missing_storage_path");
      const object = objects.get(row.storage_path);
      if (!object) throw new Error("missing_manifest_entry");
      const image = await prepareArtwork(root, object, blobs);
      plan.records.push({
        id: row.id,
        key: row.id,
        image,
        value: {
          path: row.storage_path,
          sourceSha256: image.sourceSha256,
          ...imageState(image),
        },
      });
    } catch (error) {
      const e = error as Error & { code?: string };
      const known = [
        "missing_storage_path",
        "missing_manifest_entry",
        "unsafe_path",
        "too_large",
        "size_mismatch",
        "checksum_mismatch",
        "bad_dimensions",
        "invalid_image",
        "unsupported_type",
      ];
      const reason =
        e.code === "ENOENT"
          ? "missing_file"
          : known.includes(e.message)
            ? e.message
            : "file_read_failed";
      plan.conflicts.push({
        entity: "artwork",
        key: row.id,
        reason,
        ...(error instanceof InvalidArtwork
          ? { detected_type: error.detectedType }
          : {}),
      });
    }
  }
  return plan;
}
export async function runArtwork(
  client: Client,
  plan: ArtworkPlan,
  mode: Mode,
  batchSize = 100,
) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error("Invalid batch size");
  const storage = new PostgresImageStorage();
  const conflicts = [...plan.conflicts];
  const expected: unknown[] = [],
    actual: unknown[] = [];
  let imported = 0;
  await client.query("SELECT pg_advisory_lock(726232449)");
  try {
    const mappings = (
      await client.query<{ source_pk: string; source_table: string }>(
        "SELECT source_pk, source_table FROM ops.import_mappings WHERE source_system=$1",
        [system],
      )
    ).rows;
    for (const m of mappings)
      if (
        m.source_table !== sourceTable ||
        !plan.records.some((r) => r.key === m.source_pk)
      )
        conflicts.push({
          entity: "artwork",
          key: m.source_pk,
          reason: "unexpected_mapping",
        });
    for (let offset = 0; offset < plan.records.length; offset += batchSize) {
      const batch = plan.records.slice(offset, offset + batchSize);
      await client.query(mode === "import" ? "BEGIN" : "BEGIN READ ONLY");
      try {
        for (const r of batch) {
          expected.push([r.key, imageState(r.image)]);
          const m = (
            await client.query<{ target_id: string; source_hash: string }>(
              "SELECT target_id, source_hash FROM ops.import_mappings WHERE source_system=$1 AND source_table=$2 AND source_pk=$3",
              [system, sourceTable, r.key],
            )
          ).rows[0];
          const frog = (
            await client.query<{ target_id: string }>(
              "SELECT target_id FROM ops.import_mappings WHERE source_system='FAIRGROUND' AND source_table='public.jpegpe_frog_submissions' AND source_pk=$1",
              [r.id],
            )
          ).rows[0];
          let current = await storage.load(client, r.id);
          let reason: string | undefined;
          if (!frog || frog.target_id !== r.id) reason = "frog_not_imported";
          else if (
            m &&
            (m.target_id !== r.id || m.source_hash !== hash(r.value))
          )
            reason = "source_changed";
          else if (
            m &&
            (!current ||
              hash(imageState(current)) !== hash(imageState(r.image)))
          )
            reason = "target_mismatch";
          else if (!m && current) reason = "unmapped_target_exists";
          else if (!m && mode === "verify") reason = "missing_mapping";
          if (!reason && !m && mode === "import") {
            await storage.save(client, r.id, r.image);
            await client.query(
              "INSERT INTO ops.import_mappings VALUES ($1,$2,$3,$4,$5)",
              [system, sourceTable, r.key, r.id, hash(r.value)],
            );
            current = await storage.load(client, r.id);
          }
          if (reason) conflicts.push({ entity: "artwork", key: r.key, reason });
          if (mode === "dry-run" && !reason) current = r.image;
          if (current) {
            actual.push([r.key, imageState(current)]);
            imported++;
          }
        }
        if (mode === "import") {
          const checksum = hash(batch.map((r) => [r.key, r.value]));
          await client.query(
            "INSERT INTO ops.import_checkpoints(source_system,batch_key,content_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
            [system, `v1:${checksum}`, checksum],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return {
      ok: conflicts.length === 0 && hash(expected) === hash(actual),
      planned: plan.total,
      imported,
      needs_normalization: plan.records.filter(
        (r) => r.image.needsNormalization,
      ).length,
      source_checksum: hash(expected),
      target_checksum: hash(actual),
      conflicts: conflicts.map((c) => ({ ...c, key: hash(c.key) })),
    };
  } finally {
    await client.query("SELECT pg_advisory_unlock(726232449)");
  }
}
