import type { Client } from "pg";
const projections: Record<string, string[]> = {
  ecosystem_users: ["id", "telegram_id", "created_at"],
  jpegpe_frog_submissions: [
    "id",
    "username",
    "name",
    "creator_telegram_user_id",
    "owner_telegram_user_id",
    "splash_state",
    "background_color",
    "accent_color",
    "background_drop_request_id",
    "accent_drop_request_id",
    "created_at",
  ],
  jpegpe_profile_appearances: ["telegram_user_id", "document"],
  jpegpe_color_drop_requests: ["request_id", "proof"],
  jpegpe_frog_market_listings: [
    "id",
    "frog_id",
    "seller_telegram_user_id",
    "buyer_telegram_user_id",
    "sold_at",
    "status",
  ],
  jpegpe_frog_market_offers: [
    "id",
    "frog_id",
    "seller_telegram_user_id",
    "buyer_telegram_user_id",
    "decided_at",
    "status",
  ],
  jpegpe_frog_buy_order_fills: [
    "id",
    "request_id",
    "frog_id",
    "seller_telegram_user_id",
    "buyer_telegram_user_id",
    "created_at",
  ],
  jpegpe_frog_buy_orders: [
    "id",
    "fill_request_id",
    "filled_frog_id",
    "seller_telegram_user_id",
    "buyer_telegram_user_id",
    "closed_at",
    "status",
  ],
  jpegpe_frog_trade_offers: [
    "id",
    "proposer_telegram_user_id",
    "counterparty_telegram_user_id",
    "decided_at",
    "status",
  ],
  jpegpe_frog_trade_legs: ["trade_id", "frog_id", "side"],
  jpegpe_splash_bids: [
    "id",
    "frog_id",
    "bidder_telegram_user_id",
    "updated_at",
    "status",
  ],
};
const selectionFilters: Record<string, string> = {
  jpegpe_frog_market_listings: "status = 'sold'",
  jpegpe_frog_market_offers: "status = 'accepted'",
  jpegpe_frog_trade_offers: "status = 'accepted'",
  jpegpe_splash_bids: "status = 'won'",
  jpegpe_frog_buy_orders: "status = 'filled' AND filled_frog_id IS NOT NULL",
};
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export async function skippedInventory(client: Client, used: Set<string>) {
  const skipped: { category: string; count: number }[] = [];
  const inventory = await client.query<{
    schema: string;
    name: string;
  }>(`SELECT schemaname AS schema, tablename AS name
    FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')
      AND schemaname NOT LIKE 'pg_%' ORDER BY schemaname, tablename`);
  for (const { schema, name } of inventory.rows) {
    const relation = `${quote(schema)}.${quote(name)}`;
    if (schema !== "public" || !used.has(name)) {
      const count = (
        await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${relation}`,
        )
      ).rows[0]?.n;
      skipped.push({
        category: `entire_table:${schema}.${name}`,
        count: Number(count),
      });
      continue;
    }
    const filter = selectionFilters[name];
    if (filter) {
      const count = (
        await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${relation} WHERE NOT (${filter})`,
        )
      ).rows[0]?.n;
      skipped.push({
        category: `unselected_rows:${schema}.${name}`,
        count: Number(count),
      });
    }
    if (name === "jpegpe_profile_appearances") {
      const count = (
        await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${relation}`,
        )
      ).rows[0]?.n;
      skipped.push({
        category: "profile_document_fields_except_selection",
        count: Number(count),
      });
    }
    const columns = await client.query<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,
      [schema, name],
    );
    for (const column of columns.rows)
      if (!projections[name]?.includes(column.name)) {
        const count = (
          await client.query<{ n: string }>(
            `SELECT count(${quote(column.name)})::text AS n FROM ${relation}`,
          )
        ).rows[0]?.n;
        skipped.push({
          category: `excluded_field:${schema}.${name}.${column.name}`,
          count: Number(count),
        });
      }
  }
  return skipped;
}
