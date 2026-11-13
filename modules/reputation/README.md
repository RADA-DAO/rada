# Reputation and tasks

Implementation in progress. This module owns attributed results, exact point
decisions and personal summaries. App and bot clients read the same summary.
It does not grant political rights, create money or change historical weights.
No missions or rewards are installed in production by the module migrations.

## Wire contract

`contract.ts` is the common frontend, backend and bot contract. API base is
`/v1/reputation`. Responses are JSON objects, with these fixed envelopes:

| Method and path                    | Result                                             |
| ---------------------------------- | -------------------------------------------------- |
| GET `/summary?period=...`          | `{summary: Summary}`                               |
| GET `/missions?cursor=...`         | `Page<Mission>`                                    |
| GET `/items?period=...&cursor=...` | `Page<ReputationItem>`                             |
| GET `/items/:id`                   | `{item: ReputationItem}`                           |
| POST `/missions/:id/verify`        | `CommandResult` (200 completed, 202 checking)      |
| POST `/reports`                    | `CommandResult` (202 pending interpretation)       |
| GET `/commands/:requestId`         | `CommandResult`, 404 if absent                     |
| GET `/changes?after=revision`      | `Changes`                                          |
| GET `/stream?after=revision`       | authenticated SSE; event `changes`, data `Changes` |
| POST `/items/:id/appeals`          | `{appeal: Appeal}`                                 |
| GET `/items/:id/appeals`           | `{appeals: Appeal[]}`                              |

Periods are `today`, `week`, `previous_week`, and `all`.
GET authenticates ordinary launches; POST uses the privileged launch policy.
The authenticated actor comes exclusively from the platform identity adapter.
JSON validation rejects unknown fields. Read pages have a bounded default of
30 entries. Scores are canonical exact decimal strings (at most four places),
stored as integer units at scale 10000; unrepresentable inputs are rejected.
Dates use UTC instants and calendar periods use Europe/Kyiv. Summary's total
is period-filtered; lifetimePoints is independent of the selected period.

## Required invariants

- One semantic award per actor/mission occurrence; request IDs also deduplicate.
- Reusing a request ID for different input is a conflict, not a new command.
- Completion, decision, point grant, subject revision, summary and receipt commit
  together. An external or semantic check may instead create a pending item.
- An acknowledgement mission proves the signed acknowledgement only. It must
  not claim the person read, subscribed, voted or performed another action.
- External missions remain checking until a trusted adapter provides evidence.
  No client-supplied score, identity or completion boolean is authoritative.
- A concrete self-report is recorded without mandatory attachment evidence;
  technical pending interpretation does not mean a community dispute.
- Per-subject changes are revision ordered; no global workspace lock. Missing
  delivery hints are recovered from the durable changes feed.
- Failed verification cannot erase accepted points. Corrections require an
  explicit authorized decision; appeals preserve the existing score.
- Defaults are disabled/unconfigured. Tests use synthetic missions and people.

See the root platform ownership, design and migration contracts. This README is
the implementation interface, not an adopted reward formula.
