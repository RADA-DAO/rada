export const GOVERNANCE_ROUTES = [
  "governance",
  "governance-proposal",
  "governance-settings",
] as const;
export type GovernanceRoute = (typeof GOVERNANCE_ROUTES)[number];
export const isGovernanceRoute = (route: string): route is GovernanceRoute =>
  (GOVERNANCE_ROUTES as readonly string[]).includes(route);

/** Load the implementation only when a governance route opens. */
export function loadGovernance() {
  return import("./screen.ts");
}
export type { Choice, Proposal, Rules } from "./model.ts";
