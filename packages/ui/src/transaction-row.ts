import { ListItem } from "./list.ts";
import { Text } from "./layout.ts";
/** Read-only monetary movement with caller-localized direction, amount and time. */
export function TransactionRow(options: {
  name: string;
  direction: string;
  amount: string;
  time: string;
  actions?: Node[];
}): HTMLLIElement {
  return ListItem({
    title: options.name,
    description: options.direction,
    children: [Text(options.amount), Text(options.time)],
    actions: options.actions ?? [],
  });
}
