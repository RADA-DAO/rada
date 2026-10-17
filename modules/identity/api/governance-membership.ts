import type pg from "pg";
import type { MembershipProvider } from "./membership.ts";

/** Private worker interface. Telegram identifiers never leave identity. */
export async function governanceMembershipSnapshot(
  service: pg.Pool,
  provider: MembershipProvider,
): Promise<{ members: string[]; checkedAt: string }> {
  const checkedAt = new Date().toISOString();
  const { rows } = await service.query<{
    subject_id: string;
    telegram_id: string;
  }>("SELECT * FROM identity.governance_membership_accounts()");
  const members: string[] = [];
  // Bounded concurrency; fail closed instead of treating provider failure as departure.
  for (let offset = 0; offset < rows.length; offset += 16) {
    await Promise.all(
      rows.slice(offset, offset + 16).map(async (account) => {
        const status = await provider.status(account.telegram_id, true);
        if (status === "unavailable") throw new Error("membership_unavailable");
        if (status === "member") members.push(account.subject_id);
      }),
    );
  }
  return { members, checkedAt };
}
