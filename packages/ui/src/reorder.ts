import { Button } from "./button.ts";
import { Actions, Group } from "./layout.ts";
/** Native buttons provide a keyboard and assistive-technology alternative to dragging. */
export function ReorderItem(options: {
  child: Node;
  name: string;
  earlier: string;
  later: string;
  first: boolean;
  last: boolean;
  move(direction: -1 | 1): void;
}) {
  const before = Button(options.earlier, {
    disabled: options.first,
    onClick: () => {
      options.move(-1);
    },
  });
  const after = Button(options.later, {
    disabled: options.last,
    onClick: () => {
      options.move(1);
    },
  });
  before.setAttribute("aria-label", `${options.name}: ${options.earlier}`);
  after.setAttribute("aria-label", `${options.name}: ${options.later}`);
  before.dataset.focusKey = `${options.name}-earlier`;
  after.dataset.focusKey = `${options.name}-later`;
  return Group([options.child, Actions([before, after])]);
}
