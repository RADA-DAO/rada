import type { Client } from "pg";
import type { Event, Frog, Person, Snapshot } from "./model.ts";
import { tables } from "./model.ts";
import { skippedInventory } from "./inventory.ts";
const stamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
interface RawFrog extends Omit<
  Frog,
  "creator" | "owner" | "events" | "colour_source"
> {
  creator: string;
  owner: string | null;
  splash_state: string;
}
interface Transfer {
  frog: string;
  from_id: string;
  to_id: string;
  at: string;
  key: string;
}
const histories = [
  [
    "jpegpe_frog_market_listings",
    "id",
    "seller_telegram_user_id",
    "buyer_telegram_user_id",
    "sold_at",
    "status = 'sold'",
  ],
  [
    "jpegpe_frog_market_offers",
    "id",
    "seller_telegram_user_id",
    "buyer_telegram_user_id",
    "decided_at",
    "status = 'accepted'",
  ],
  [
    "jpegpe_frog_buy_order_fills",
    "id",
    "seller_telegram_user_id",
    "buyer_telegram_user_id",
    "created_at",
    "true",
  ],
] as const;
export async function readSource(client: Client): Promise<Snapshot> {
  // Fail rather than silently reading policy-filtered subsets on an RLS restore.
  await client.query("SET LOCAL row_security = off");
  const result: Snapshot = {
    records: [],
    conflicts: [],
    skipped: [],
    counts: {},
  };
  const inventory = await client.query<{
    name: string;
  }>(`SELECT tablename AS name FROM pg_tables
    WHERE schemaname = 'public' ORDER BY tablename`);
  const names = new Set(inventory.rows.map((r) => r.name));
  for (const required of Object.values(tables))
    if (!names.has(required.slice(7)))
      throw new Error(`Missing required source table: ${required}`);
  const used = new Set(Object.values(tables).map((t) => t.slice(7)));
  const transfers: Transfer[] = [];
  for (const [name, key, from, to, at, filter] of histories) {
    if (!names.has(name)) continue;
    used.add(name);
    const rows =
      await client.query<Transfer>(`SELECT frog_id::text AS frog, ${from}::text AS from_id,
      ${to}::text AS to_id, ${stamp(at)} AS at, 'public.${name}:' || ${key}::text AS key
      FROM public.${name} WHERE ${filter}`);
    transfers.push(...rows.rows);
  }
  if (
    names.has("jpegpe_frog_trade_offers") &&
    names.has("jpegpe_frog_trade_legs")
  ) {
    used.add("jpegpe_frog_trade_offers");
    used.add("jpegpe_frog_trade_legs");
    const rows = await client.query<Transfer>(`SELECT l.frog_id::text AS frog,
      (CASE WHEN l.side = 'proposer' THEN t.proposer_telegram_user_id ELSE t.counterparty_telegram_user_id END)::text AS from_id,
      (CASE WHEN l.side = 'proposer' THEN t.counterparty_telegram_user_id ELSE t.proposer_telegram_user_id END)::text AS to_id,
      ${stamp("t.decided_at")} AS at, 'public.jpegpe_frog_trade_legs:' || t.id::text || ':' || l.frog_id::text AS key
      FROM public.jpegpe_frog_trade_offers t JOIN public.jpegpe_frog_trade_legs l ON l.trade_id = t.id
      WHERE t.status = 'accepted'`);
    transfers.push(...rows.rows);
  }
  // Older single-fill orders were not backfilled into the later fills table.
  if (names.has("jpegpe_frog_buy_orders")) {
    used.add("jpegpe_frog_buy_orders");
    const rows =
      await client.query<Transfer>(`SELECT filled_frog_id::text AS frog,
      seller_telegram_user_id::text AS from_id, buyer_telegram_user_id::text AS to_id,
      ${stamp("closed_at")} AS at, 'public.jpegpe_frog_buy_orders:' || id::text AS key
      FROM public.jpegpe_frog_buy_orders o WHERE status = 'filled' AND filled_frog_id IS NOT NULL
      ${names.has("jpegpe_frog_buy_order_fills") ? "AND NOT EXISTS (SELECT 1 FROM public.jpegpe_frog_buy_order_fills f WHERE f.request_id = o.fill_request_id)" : ""}`);
    transfers.push(...rows.rows);
  }
  if (names.has("jpegpe_notification_events")) {
    // Only the reviewed notification shape is known to contain no ownership evidence.
    const unknown = await client.query<{
      id: string;
      notification_only: boolean;
    }>(
      `SELECT id::text, coalesce(jsonb_typeof(payload) = 'object'
        AND payload ?& ARRAY['frogId','frogName','frogUsername','level']
        AND payload - ARRAY['frogId','frogName','frogUsername','level'] = '{}'::jsonb,
        false) AS notification_only
       FROM public.jpegpe_notification_events WHERE event_type = 'frog.transferred'`,
    );
    for (const e of unknown.rows)
      if (e.notification_only)
        result.skipped.push({
          category: "transfer_notification_without_endpoints",
          count: 1,
        });
      else
        result.conflicts.push({
          entity: "ownership_events",
          key: e.id,
          reason: "unrecognized_transfer_payload_requires_adapter",
        });
  }
  // SPLASH wins are ownership evidence only; amounts and payouts are never read.
  if (names.has("jpegpe_splash_bids")) {
    used.add("jpegpe_splash_bids");
    const rows = await client.query<Transfer>(`SELECT b.frog_id::text AS frog,
      f.creator_telegram_user_id::text AS from_id, b.bidder_telegram_user_id::text AS to_id,
      ${stamp("b.updated_at")} AS at, 'public.jpegpe_splash_bids:' || b.id::text AS key
      FROM public.jpegpe_splash_bids b JOIN public.jpegpe_frog_submissions f ON f.id = b.frog_id
      WHERE b.status = 'won'`);
    transfers.push(...rows.rows);
  }
  const peopleCount = (
    await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM public.ecosystem_users",
    )
  ).rows[0]?.n;
  const people = (
    await client.query<Person>(`SELECT id::text, telegram_id::text,
    ${stamp("created_at")} AS created_at FROM public.ecosystem_users ORDER BY id`)
  ).rows;
  if (people.length === 0 && Number(peopleCount) > 0)
    throw new Error(
      "People source returned zero rows despite non-zero inventory count",
    );
  const telegram = new Map<string, string>();
  const duplicate = new Set<string>();
  for (const p of people)
    if (p.telegram_id) {
      if (telegram.has(p.telegram_id)) duplicate.add(p.telegram_id);
      telegram.set(p.telegram_id, p.id);
    }
  for (const p of people) {
    if (
      p.telegram_id &&
      (duplicate.has(p.telegram_id) || !/^[1-9][0-9]*$/.test(p.telegram_id))
    ) {
      result.conflicts.push({
        entity: "people",
        key: p.id,
        reason: "ambiguous_or_invalid_telegram",
      });
      continue;
    }
    result.records.push({ entity: "people", key: p.id, id: p.id, value: p });
  }
  const validPeople = new Set(result.records.map((r) => r.id));
  const subject = (id: string | null) =>
    id && !duplicate.has(id) ? telegram.get(id) : undefined;
  let proofJoin = "";
  let proofs = "NULL::jsonb AS background_proof, NULL::jsonb AS accent_proof";
  if (names.has("jpegpe_color_drop_requests")) {
    used.add("jpegpe_color_drop_requests");
    proofJoin = `LEFT JOIN public.jpegpe_color_drop_requests bg ON bg.request_id = f.background_drop_request_id
      LEFT JOIN public.jpegpe_color_drop_requests ac ON ac.request_id = f.accent_drop_request_id`;
    proofs = "bg.proof AS background_proof, ac.proof AS accent_proof";
  }
  const frogs = (
    await client.query<RawFrog>(`SELECT f.id::text, f.username, f.name AS display_name,
    f.creator_telegram_user_id::text AS creator, f.owner_telegram_user_id::text AS owner,
    f.splash_state, f.background_color, f.accent_color, ${proofs}, ${stamp("f.created_at")} AS created_at
    FROM public.jpegpe_frog_submissions f ${proofJoin} ORDER BY f.id`)
  ).rows;
  for (const f of frogs) {
    if (f.splash_state !== "owned" || !f.owner) {
      result.skipped.push({
        category: `frogs_${f.splash_state}_without_active_owner`,
        count: 1,
      });
      continue;
    }
    const colour_source =
      (f.background_color !== null && f.background_proof === null) ||
      (f.accent_color !== null && f.accent_proof === null)
        ? "legacy_unverified"
        : "proof";
    if (colour_source === "legacy_unverified")
      result.skipped.push({
        category: "legacy_colour_without_proof",
        count: 1,
      });
    const creator = subject(f.creator),
      owner = subject(f.owner);
    if (
      !creator ||
      !owner ||
      !validPeople.has(creator) ||
      !validPeople.has(owner)
    ) {
      result.conflicts.push({
        entity: "frogs",
        key: f.id,
        reason: "unmapped_person",
      });
      continue;
    }
    const events: Event[] = [
      {
        from: null,
        to: creator,
        at: f.created_at,
        key: `FAIRGROUND:frog:${f.id}:created`,
        imported: true,
      },
    ];
    const history = transfers
      .filter((t) => t.frog === f.id)
      .sort((a, b) =>
        a.at < b.at
          ? -1
          : a.at > b.at
            ? 1
            : a.key < b.key
              ? -1
              : a.key > b.key
                ? 1
                : 0,
      );
    let prior = creator,
      previousAt = f.created_at,
      broken = false;
    for (const t of history) {
      const from = subject(t.from_id),
        to = subject(t.to_id);
      if (from !== prior || !to || from === to || !t.at || t.at < previousAt) {
        broken = true;
        break;
      }
      events.push({
        from,
        to,
        at: t.at,
        key: `FAIRGROUND:${t.key}`,
        imported: true,
      });
      prior = to;
      previousAt = t.at;
    }
    if (history.length === 0 && creator !== owner) {
      events.push({
        from: creator,
        to: owner,
        at: f.created_at,
        key: `FAIRGROUND:frog:${f.id}:imported`,
        imported: true,
      });
      prior = owner;
    }
    if (broken || prior !== owner) {
      result.conflicts.push({
        entity: "frogs",
        key: f.id,
        reason: "ownership_history_mismatch",
      });
      continue;
    }
    const authored = { ...f };
    delete (authored as Partial<RawFrog>).splash_state;

    result.records.push({
      entity: "frogs",
      key: f.id,
      id: f.id,
      value: {
        ...authored,
        colour_source,
        username: f.username.replace(/^@/, ""),
        creator,
        owner,
        events,
      },
    });
  }
  const profiles = (
    await client.query<{
      telegram_id: string;
      frog: string;
    }>(`SELECT telegram_user_id::text AS telegram_id,
    document #>> '{profile,frogId}' AS frog FROM public.jpegpe_profile_appearances
    WHERE document #>> '{profile,frogId}' IS NOT NULL ORDER BY telegram_user_id`)
  ).rows;
  for (const p of profiles) {
    const id = subject(p.telegram_id);
    const f = result.records.find(
      (r) => r.entity === "frogs" && r.id === p.frog,
    )?.value as Frog | undefined;
    if (!id || !f || f.owner !== id) {
      result.skipped.push({
        category: "selection_not_currently_owned_or_unmapped",
        count: 1,
      });
      continue;
    }
    result.records.push({
      entity: "selections",
      key: p.telegram_id,
      id,
      value: { id, frog: p.frog },
    });
  }
  result.counts = {
    people: people.length,
    frogs: frogs.length,
    selections: profiles.length,
    ownership_evidence: transfers.length,
  };
  result.skipped.push(...(await skippedInventory(client, used)));
  result.skipped.push({
    category: "people_without_telegram_link",
    count: people.filter((p) => !p.telegram_id).length,
  });
  return result;
}
