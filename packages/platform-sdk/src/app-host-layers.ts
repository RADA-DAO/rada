import type { SheetNavigation } from "../../ui/src/index.ts";

/** A community frame owns at most one modal entry, never arbitrary host routes. */
export function appHostLayer(options: {
  navigation?: SheetNavigation & { readonly top?: { key: string } };
  key: string;
  dismiss(): void;
}) {
  let open = false;
  const ownerKey = options.navigation?.top?.key;
  return {
    open() {
      const top = options.navigation?.top?.key;
      if (
        !options.navigation ||
        !ownerKey ||
        (top !== ownerKey && top !== options.key)
      )
        return { opened: false };
      if (!open) {
        open = true;
        options.navigation.push({
          key: options.key,
          stale: () => !open,
          leave() {
            if (!open) return;
            open = false;
            options.dismiss();
          },
        });
      }
      return { opened: true };
    },
    close() {
      open = false;
      if (options.navigation?.top?.key === options.key)
        options.navigation.drop(options.key);
      return { closed: true };
    },
  };
}
