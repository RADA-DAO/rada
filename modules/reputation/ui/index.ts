export const REPUTATION_ROUTES = [
  "tasks",
  "reputation",
  "reputation-item",
] as const;
export type ReputationRoute = (typeof REPUTATION_ROUTES)[number];
export const isReputationRoute = (route: string): route is ReputationRoute =>
  (REPUTATION_ROUTES as readonly string[]).includes(route);
export function loadReputation() {
  return import("./screen.ts");
}
