import { Avatar } from "./avatar.ts";
import { Badge } from "./facts.ts";
import { element } from "./dom.ts";

/** A public ranking entry, with exact caller-formatted amount and freshness. */
export function RankingRow(options: {
  rank: string;
  frogId: string;
  name: string;
  amount: string;
  asOf: string;
  staleLabel?: string;
  viewerLabel?: string;
}): HTMLLIElement {
  const row = element("li", "rada-ranking-row");
  if (options.viewerLabel) row.setAttribute("aria-current", "true");
  const identity = element("div", "rada-ranking-identity");
  identity.append(element("p", "rada-ranking-name", options.name));
  if (options.viewerLabel) identity.append(Badge(options.viewerLabel));
  const value = element("div", "rada-ranking-value");
  value.append(element("p", "rada-ranking-amount", options.amount));
  value.append(element("p", "rada-ranking-time", options.asOf));
  if (options.staleLabel) value.append(Badge(options.staleLabel));
  row.append(
    element("span", "rada-ranking-rank", options.rank),
    Avatar({ name: options.name, frogId: options.frogId }),
    identity,
    value,
  );
  return row;
}
