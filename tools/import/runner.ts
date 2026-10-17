import type { Client } from "pg";
import {
  hash,
  table,
  type Conflict,
  type Frog,
  type Person,
  type RecordPlan,
  type Selection,
  type Snapshot,
} from "./model.ts";
export type Mode = "dry-run" | "import" | "verify";
interface Mapping {
  target_id: string;
  source_hash: string;
}
async function mapping(
  client: Client,
  r: RecordPlan,
): Promise<Mapping | undefined> {
  return (
    await client.query<Mapping>(
      `SELECT target_id, source_hash FROM ops.import_mappings
    WHERE source_system = 'FAIRGROUND' AND source_table = $1 AND source_pk = $2`,
      [table(r.entity), r.key],
    )
  ).rows[0];
}
async function state(client: Client, r: RecordPlan): Promise<unknown> {
  if (r.entity === "selections") {
    const frog = (
      await client.query<{ value: string | null }>(
        "SELECT identity.import_selection_state($1) AS value",
        [r.id],
      )
    ).rows[0]?.value;
    return frog ? { id: r.id, frog } : null;
  }
  const fn =
    r.entity === "people"
      ? "identity.import_person_state"
      : "jpegpe.import_frog_state";
  return (
    await client.query<{ value: unknown }>(`SELECT ${fn}($1) AS value`, [r.id])
  ).rows[0]?.value;
}
async function write(client: Client, r: RecordPlan): Promise<void> {
  if (r.entity === "people") {
    const p = r.value as Person;
    await client.query("SELECT identity.import_person($1,$2,$3)", [
      p.id,
      p.telegram_id,
      p.created_at,
    ]);
  } else if (r.entity === "frogs") {
    await client.query("SELECT jpegpe.import_frog($1::jsonb)", [
      JSON.stringify(r.value),
    ]);
  } else {
    const p = r.value as Selection;
    const selected = await client.query<{ ok: boolean }>(
      "SELECT identity.import_selection($1,$2) AS ok",
      [p.id, p.frog],
    );
    if (!selected.rows[0]?.ok) throw new Error("Selection ownership changed");
  }
  await client.query(
    `INSERT INTO ops.import_mappings(source_system,source_table,source_pk,target_id,source_hash)
    VALUES ('FAIRGROUND',$1,$2,$3,$4)`,
    [table(r.entity), r.key, r.id, hash(r.value)],
  );
}
export async function runImport(
  client: Client,
  snapshot: Snapshot,
  mode: Mode,
  batchSize = 100,
) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error("Invalid batch size");
  const conflicts: Conflict[] = [...snapshot.conflicts];
  const known = new Set(
    snapshot.records.map((r) => `${table(r.entity)}:${r.key}`),
  );
  const mappings = await client.query<{
    source_table: string;
    source_pk: string;
  }>(
    "SELECT source_table, source_pk FROM ops.import_mappings WHERE source_system = 'FAIRGROUND'",
  );
  for (const m of mappings.rows)
    if (!known.has(`${m.source_table}:${m.source_pk}`))
      conflicts.push({
        entity: m.source_table,
        key: m.source_pk,
        reason: "unexpected_mapping",
      });
  const accepted: RecordPlan[] = [];
  const validPeople = new Set<string>(),
    validFrogs = new Set<string>();
  const names = new Map<string, number>();
  for (const r of snapshot.records)
    if (r.entity === "frogs") {
      const name = (r.value as Frog).username.toLowerCase();
      names.set(name, (names.get(name) ?? 0) + 1);
    }
  // One session lock serializes rehearsals, including all committed batches.
  await client.query("SELECT pg_advisory_lock(726232449)");
  try {
    for (
      let offset = 0;
      offset < snapshot.records.length;
      offset += batchSize
    ) {
      const batch = snapshot.records.slice(offset, offset + batchSize);
      await client.query(mode === "import" ? "BEGIN" : "BEGIN READ ONLY");
      try {
        for (const r of batch) {
          let reason: string | undefined;
          const m = await mapping(client, r);
          const current = await state(client, r);
          if (m && (m.target_id !== r.id || m.source_hash !== hash(r.value)))
            reason = "source_changed";
          else if (m && hash(current) !== hash(r.value))
            reason = "target_mismatch";
          else if (!m && current) reason = "unmapped_target_exists";
          if (r.entity === "people" && !m && !reason) {
            const p = r.value as Person;
            if (
              p.telegram_id &&
              !(
                await client.query<{ ok: boolean }>(
                  "SELECT identity.import_telegram_available($1) AS ok",
                  [p.telegram_id],
                )
              ).rows[0]?.ok
            )
              reason = "telegram_already_linked";
          }
          if (r.entity === "frogs") {
            const f = r.value as Frog;
            if (
              !validPeople.has(f.creator) ||
              !validPeople.has(f.owner) ||
              f.events.some(
                (e) =>
                  !validPeople.has(e.to) ||
                  (e.from !== null && !validPeople.has(e.from)),
              )
            )
              reason = "person_dependency";
            else if (
              [f.background_color, f.accent_color].some(
                (c) => c !== null && !/^#[0-9A-Fa-f]{6}$/.test(c),
              ) ||
              [f.background_proof, f.accent_proof].some(
                (p) =>
                  p !== null && (typeof p !== "object" || Array.isArray(p)),
              )
            )
              reason = "invalid_colour_or_proof";
            else if ((names.get(f.username.toLowerCase()) ?? 0) > 1)
              reason = "source_name_collision";
            else if (!m && !reason) {
              const status = (
                await client.query<{ value: string }>(
                  "SELECT jpegpe.username_status($1) AS value",
                  [f.username],
                )
              ).rows[0]?.value;
              if (status !== "available")
                reason = `name_${status ?? "unknown"}`;
            }
          }
          if (
            r.entity === "selections" &&
            (!validPeople.has(r.id) ||
              !validFrogs.has((r.value as Selection).frog))
          )
            reason = "selection_dependency";
          if (!reason && !m && mode === "verify") reason = "missing_mapping";
          if (!reason && !m && mode === "import") {
            await client.query("SAVEPOINT import_record");
            try {
              await write(client, r);
            } catch (error) {
              await client.query("ROLLBACK TO SAVEPOINT import_record");
              const code = (error as { code?: string }).code;
              if (
                !code ||
                ![
                  "23505",
                  "23514",
                  "23503",
                  "22023",
                  "22007",
                  "22P02",
                ].includes(code)
              )
                throw error;
              reason = `constraint_${code}`;
            }
            await client.query("RELEASE SAVEPOINT import_record");
          }
          if (reason) conflicts.push({ entity: r.entity, key: r.key, reason });
          else {
            accepted.push(r);
            if (r.entity === "people") validPeople.add(r.id);
            if (r.entity === "frogs") validFrogs.add(r.id);
          }
        }
        if (mode === "import") {
          const content = hash(batch);
          await client.query(
            `INSERT INTO ops.import_checkpoints(source_system,batch_key,content_hash)
            VALUES ('FAIRGROUND',$1,$2) ON CONFLICT DO NOTHING`,
            [`v1:${content}`, content],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    const entities: Record<
      string,
      {
        source: number;
        planned: number;
        imported: number;
        source_checksum: string;
        target_checksum: string;
        mismatches: number;
      }
    > = {};
    for (const entity of [
      "people",
      "frogs",
      "selections",
      "ownership_events",
    ]) {
      const expected: [string, unknown][] = [],
        actual: [string, unknown][] = [];
      const records = snapshot.records.filter(
        (r) => r.entity === (entity === "ownership_events" ? "frogs" : entity),
      );
      for (const r of records) {
        const value =
          mode === "dry-run"
            ? accepted.includes(r)
              ? r.value
              : null
            : await state(client, r);
        if (entity === "ownership_events") {
          expected.push(
            ...(r.value as Frog).events.map((e): [string, unknown] => [
              e.key,
              e,
            ]),
          );
          if (value)
            actual.push(
              ...(value as Frog).events.map((e): [string, unknown] => [
                e.key,
                e,
              ]),
            );
        } else {
          expected.push([r.key, r.value]);
          if (value) actual.push([r.key, value]);
        }
      }
      const sort = (a: [string, unknown], b: [string, unknown]) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      const sourceChecksum = hash(expected.sort(sort));
      const targetChecksum = hash(actual.sort(sort));
      const expectedMap = new Map(
        expected.map(([key, value]) => [key, hash(value)]),
      );
      const actualMap = new Map(
        actual.map(([key, value]) => [key, hash(value)]),
      );
      const mismatches = [
        ...new Set([...expectedMap.keys(), ...actualMap.keys()]),
      ].filter((key) => expectedMap.get(key) !== actualMap.get(key)).length;
      entities[entity] = {
        source: snapshot.counts[entity] ?? expected.length,
        planned: expected.length,
        imported: actual.length,
        source_checksum: sourceChecksum,
        target_checksum: targetChecksum,
        mismatches,
      };
    }
    const skipped = new Map<string, number>();
    for (const entry of snapshot.skipped)
      skipped.set(
        entry.category,
        (skipped.get(entry.category) ?? 0) + entry.count,
      );
    return {
      version: 1,
      snapshot_checksum: hash(snapshot),
      mode,
      ok:
        conflicts.length === 0 &&
        Object.values(entities).every((e) => e.mismatches === 0),
      counts: snapshot.counts,
      entities,
      conflicts: conflicts.map((c) => ({ ...c, key: hash(c.key) })),
      skipped: [...skipped].map(([category, count]) => ({ category, count })),
    };
  } finally {
    await client.query("SELECT pg_advisory_unlock(726232449)");
  }
}
