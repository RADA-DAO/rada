import type { Page } from "@playwright/test";
import type {
  Choice,
  Proposal,
  Rules,
} from "../../../modules/governance/ui/index.ts";
export const id = "11111111-1111-4111-8111-111111111111";
export const rules: Rules = {
  who_opens: "steward-opens",
  duration_hours: 48,
  decision_days: 7,
  allow_vote_changes: true,
  require_membership_at_open: false,
  keep_departed_votes: true,
  allow_majority_override: true,
};
export const proposal = (): Proposal => ({
  proposal_id: id,
  title: "Community workshop",
  body: "Run a public workshop and publish the recording.",
  state: "opened",
  closes_at: new Date(Date.now() + 3600000).toISOString(),
  rules,
  tally: { for: 2, against: 1, abstain: 0 },
  decision_status: "not_due",
  decision: null,
  evidence: [],
  withdrawal_reason: null,
});
/** Browser contracts are deterministic; real API/SQL contracts run separately. */
export async function governanceFixture(
  page: Page,
  options: {
    member?: boolean;
    steward?: boolean;
    guest?: boolean;
    proposal?: Proposal;
    rateLimit?: boolean;
  } = {},
) {
  const p = options.proposal ?? proposal();
  let mine:
    { proposal_id: string; choice: Choice | null; receipt: string } | undefined;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ body: "" }),
  );
  await page.addInitScript((guest) => {
    Object.assign(window, {
      Telegram: {
        WebApp: {
          initData: guest ? "" : "synthetic-governance-fixture",
          ready() {},
          expand() {},
          onEvent() {},
          offEvent() {},
          BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
        },
      },
    });
  }, options.guest ?? false);
  await page.route("**/me", (route) =>
    route.fulfill({
      json: {
        subject_id: "00000000-0000-4000-8000-000000000101",
        profile: { visibility: "private", public: null },
        membership: { status: options.member ? "member" : "not_member" },
      },
    }),
  );
  await page.route("**/apps/published", (route) =>
    route.fulfill({ json: { apps: [] } }),
  );
  await page.route("**/v1/governance/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/v1/governance", "");
    if (request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path, body });
      if (options.rateLimit) {
        await route.fulfill({
          status: 429,
          headers: {
            "Retry-After": "120",
            "Access-Control-Expose-Headers": "Retry-After",
          },
          json: { error: "rate_limited" },
        });
        return;
      }
      if (path.endsWith("/vote")) {
        if (mine?.choice) p.tally[mine.choice]--;
        mine = {
          proposal_id: id,
          choice: body.choice as Choice | null,
          receipt: `receipt-${String(writes.length)}`,
        };
        if (mine.choice) p.tally[mine.choice]++;
      }
      if (path.endsWith("/decide"))
        p.decision = {
          outcome: body.outcome as "accept" | "reject" | "defer",
          reason: String(body.reason),
        };
      if (path.endsWith("/evidence"))
        p.evidence.push({
          body: String(body.body),
          link: typeof body.link === "string" ? body.link : null,
          tx_hash: typeof body.tx_hash === "string" ? body.tx_hash : null,
        });
      await route.fulfill({ json: { result: null } });
      return;
    }
    const response =
      path === "/viewer"
        ? { viewer: { steward: options.steward ?? false } }
        : path === "/settings"
          ? { settings: { version: 1, rules } }
          : path === "/settings/history"
            ? {
                history: [
                  {
                    version: 1,
                    rules,
                    reason: "Initial defaults",
                    changed_at: "2026-10-16T00:00:00Z",
                  },
                ],
              }
            : path === "/votes/mine"
              ? { votes: mine ? [mine] : [] }
              : path.endsWith("/votes")
                ? {
                    votes: [
                      {
                        vote_id: "1",
                        receipt: "public-receipt",
                        choice: "for",
                        voter: { username: "Public Frog" },
                        current: true,
                        excluded: false,
                      },
                      {
                        vote_id: "2",
                        receipt: "private-receipt",
                        choice: "against",
                        voter: null,
                        current: true,
                        excluded: false,
                      },
                    ],
                  }
                : path === "/proposals"
                  ? { proposals: [p] }
                  : { proposal: p };
    await route.fulfill({ json: response });
  });
  await page.goto("/");
  return { p, writes };
}
