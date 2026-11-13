# Reputation release and rollback gates

This is an engineering release procedure, not adopted scoring policy or an
approval to deploy, publish, activate a provider, import history or move money.
The candidate contains the API/UI, shared projection renderer, durable worker
interfaces and synthetic verification tools. Production cutover remains gated.

## Current boundary

Migrations 0066–0074 are reputation-owned; 0075 is identity-owned. They introduce
scoped projections/commands, trusted decision interfaces, jobs/leases, immutable
rules and report completion, plus a narrow verified-identity lookup for external
jobs. They seed no mission or reward formula. Pending inputs can enqueue jobs,
but no coordinator, provider, Telegram subscription reward or live bot route is
automatically enabled. The API service pool is separate from worker, ingress,
operator and migration credentials.

The application and pure bot renderer use the same summary contract. Legacy
source projections for shadow comparison must be prepared read-only using
explicit source identity, event keys, cutoff, rules and Kyiv period boundaries.
The offline comparison CLI consumes those projections; no production import or
complete real-source exporter is established by the synthetic harness.

Local checks and the measured initial JavaScript budget adjustment in
[verification evidence](reputation-verification.md) establish
specific synthetic behavior, including the 16 store, 13 worker and four
coordinator/database checks. They do not establish production parity, genuine
community workload performance, historical rule adoption or financial state.

## F4: two real weeks of shadow evidence

Before requesting cutover approval, complete two actual reporting weeks with
legacy/source and candidate projections observed side by side. Synthetic weeks,
example fixtures and an elapsed timer cannot substitute for real source data.
Record the reporting boundaries and a common cutoff/ruleset for each comparison.

For every observed week:

1. Capture an independently agreed full roster, including members with zero
   activity. Keep private attribution/evidence outside public repository artifacts.
2. Produce complete source/candidate projections using the same cutoff,
   authorized frozen rules, stable occurrence/evidence keys and Europe/Kyiv
   calendar boundaries. Preserve pending, excluded and superseded dispositions.
3. Run `tools/reputation-shadow.ts LEGACY.json CANDIDATE.json EXPECTED-ROSTER.json`.
   Compare all members, all category zeros, individual rows, evidence keys,
   exclusions and exact totals; a leaderboard subset is insufficient.
4. Reconcile each difference against independent source events and decisions.
   Record missing evidence, ambiguous rules and identity mappings explicitly.
   A technical interpretation backlog is not a community dispute. Do not hide a
   difference by changing weights or dropping rows on both sides.
5. Retain sanitized evidence manifests, hashes, result counts, unresolved issues
   and reviewer conclusions. Require both weeks to meet the agreed parity
   criteria before F5; unresolved scoring or attribution differences block it.

A comparison result is evidence about supplied projections. Completeness and
source correctness still need independent review; no comparator can detect an
event omitted identically from both producers without that source evidence.

## F5: explicit approval and observation

After F4, prepare a concrete release packet: exact candidate revision, migration
ledger/checksums, complete test results, two-week reconciliation evidence,
authorized rule/mission configuration, trusted source/fact selectors, provider
budgets, operational ownership and the fenced rollback plan below.

Obtain explicit approval through the existing platform release process before
production writes, bot routing or worker/provider activation. Freeze a handoff
cutoff and one authoritative writer. Define the observation duration, failure
thresholds and rollback decision owner before activation; a local p95 result is
not an adopted production SLO.

Observe for the existing F5 minimum of three days before wider rollout.
Track authenticated own-member flows, pending versus accepted projections,
command/appeal recovery after reload, SSE reconnect/catch-up, exact categories,
identity isolation, worker lease/retry/blocked counts, provider budgets and
trusted external authority. Verify actual deployed state and absence of dual
writers. F5 is complete only after the approved observation criteria are met.
A green build or synthetic load result cannot close either release gate.

## Rollback after new writes

Rollback must preserve every accepted post-cutover write and its audit trail.
Do not restore an old seed or overwrite a live database with a pre-cutover
snapshot after new writes have begun.

1. Fence new mutation admission and job claiming at the agreed boundary. Keep
   receipt/status reads available where possible. Fence the previous writer too;
   do not create a period of dual authority while switching routes.
2. Drain in-flight database commits and bounded preparation work. Resolve unknown
   HTTP/worker outcomes through immutable receipts. Record pending, leased,
   blocked and completed jobs, appeals, revisions and outstanding external inputs.
   Do not reset leases or counters to manufacture a clean shutdown.
3. Capture and verify the fenced state and ledger. Inventory the complete delta
   since the original handoff: attributed items, point decisions/corrections,
   command and job receipts, semantic keys, rule hashes, changes and job state.
4. Reconcile that delta into the chosen rollback destination using stable
   identities and idempotent keys. Preserve exact scores, exclusions and audit
   history. Test restore/replay on an isolated copy and compare projections at
   the fenced cutoff before allowing writes there.
5. If the previous implementation cannot represent/reconcile the new delta,
   keep mutation paths fenced and expose a reconciled read-only/pending state.
   Route rollback alone must not make an old seed authoritative again. Reopen a
   single writer only after explicit approval and verified reconciliation.

Applied migration history is forward-only. A UI/API rollback needs compatible
reads or a forward corrective migration; dropping the new schema or replaying a
legacy seed is not a data-preserving rollback procedure. This module introduces
no financial migration; any future payout or political-rights proposal needs
its own authority and release contract.
