import {
  captureSwipeBackPage,
  type SwipeBackPreviewFactory,
} from "./swipe-back.ts";

export type PageBackRoute = {
  key: string;
  parent?: string;
  /** Omit on a module's root page to use the containing shell's destination. */
  back?: () => void;
  /** Pending writes block both native Back and swipe; editors may block only swipe. */
  blocked?: () => boolean;
  canSwipe?: () => boolean;
};
type Scope = {
  root: HTMLElement;
  route: PageBackRoute;
  snapshots: Map<string, SwipeBackPreviewFactory>;
  scrolls: Map<string, number>;
};
const scopes = new WeakMap<HTMLElement, Scope>();
const deferred = new WeakMap<HTMLElement, () => void>();
const activePages = new WeakSet<HTMLElement>();
let onChange: (() => void) | undefined;
export function onPageBackChange(listener: () => void): void {
  onChange = listener;
}

/** Call before replacing a page's content. Route state belongs to the module. */
export function configurePageBack(
  root: HTMLElement,
  route: PageBackRoute,
): void {
  let scope = scopes.get(root);
  if (!scope) {
    scope = { root, route, snapshots: new Map(), scrolls: new Map() };
    scopes.set(root, scope);
  } else if (scope.route.key !== route.key) {
    const screen =
      root.closest<HTMLElement>(".screen") ??
      root.querySelector<HTMLElement>(".screen-wrap > .screen");
    if (screen) {
      scope.snapshots.delete(scope.route.key);
      scope.snapshots.set(scope.route.key, captureSwipeBackPage(screen));
      scope.scrolls.set(scope.route.key, screen.scrollTop);
      while (scope.snapshots.size > 12) {
        const key = scope.snapshots.keys().next().value!;
        scope.snapshots.delete(key);
        scope.scrolls.delete(key);
      }
    }
  }
  scope.route = route;
  root.setAttribute("data-page-back-scope", "");
  onChange?.();
}

/** Deepest module handles its own page first, then the shell handles app/origin return. */
export function pageBackNavigation(screen: HTMLElement) {
  const nodes = [
    ...screen.querySelectorAll<HTMLElement>("[data-page-back-scope]"),
  ].reverse();
  for (let node: HTMLElement | null = screen; node; node = node.parentElement)
    nodes.push(node);
  const current = nodes
    .map((node) => scopes.get(node))
    .filter((scope): scope is Scope => Boolean(scope));
  const owner = current.find((scope) => scope.route.back);
  return {
    available: Boolean(owner),
    canSwipe: () =>
      Boolean(owner) &&
      current.every(
        ({ route }) => !route.blocked?.() && (route.canSwipe?.() ?? true),
      ),
    back(): boolean {
      // A pending operation consumes Back rather than falling through to app exit.
      if (current.some(({ route }) => route.blocked?.())) return true;
      if (!owner) return false;
      const parent = owner.route.parent;
      const scroll = parent ? owner.scrolls.get(parent) : undefined;
      owner.route.back!();
      if (scroll !== undefined)
        requestAnimationFrame(() => {
          if (
            !owner.root.isConnected ||
            scopes.get(owner.root)?.route.key !== parent
          )
            return;
          const page =
            owner.root.closest<HTMLElement>(".screen") ??
            owner.root.querySelector<HTMLElement>(".screen-wrap > .screen");
          if (page) page.scrollTop = scroll;
        });
      return true;
    },
    preview: () =>
      owner?.route.parent
        ? (owner.snapshots.get(owner.route.parent)?.() ?? null)
        : null,
  };
}

/** Async data must not replace the element being dragged or its destination. */
export function deferPageBackRender(
  root: HTMLElement,
  render: () => void,
): boolean {
  const screen = root.closest<HTMLElement>(".screen");
  if (!screen || !activePages.has(screen)) return false;
  deferred.set(root, render);
  return true;
}

export function setPageBackActive(screen: HTMLElement, active: boolean): void {
  if (active) {
    activePages.add(screen);
    return;
  }
  activePages.delete(screen);
  // Navigation happens synchronously after gesture reset; only repaint still-live scopes.
  const nodes = [
    screen,
    ...screen.querySelectorAll<HTMLElement>("[data-page-back-scope]"),
  ];
  requestAnimationFrame(() => {
    for (const node of nodes) {
      const render = deferred.get(node);
      deferred.delete(node);
      if (node.isConnected && render) render();
    }
  });
}

/** Reuse the module's existing explicit Back action, including draft/scroll semantics. */
export function clickPageBack(root: HTMLElement, selector: string): void {
  root.querySelector<HTMLButtonElement>(selector)?.click();
}
