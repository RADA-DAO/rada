import { createChunkLoader } from "./chunk-loader.ts";
import { createLazyScreen } from "./lazy-screen.ts";
import { ErrorState, Loading } from "../../../packages/ui/src/index.ts";
import { t } from "../../../packages/i18n/src/index.ts";
import type { mountProfilePanel } from "./profile-panel.ts";
import type { showCollection } from "./collection.ts";
const panel = createChunkLoader(() => import("./profile-panel.ts"), "profile");
const collection = createChunkLoader(
  () => import("./collection.ts"),
  "collection",
);
export function mountLazyProfile(
  host: HTMLElement,
  options: Parameters<typeof mountProfilePanel>[1],
) {
  let stopped = false;
  let dispose: (() => void) | undefined;
  const target = host.querySelector<HTMLElement>("[data-profile-collection]");
  if (!target) return () => {};
  const load = async () => {
    target.replaceChildren(
      Loading({ message: t(options.locale, "common.loading") }),
    );
    try {
      const module = await panel();
      if (!stopped) {
        target.replaceChildren();
        dispose = module.mountProfilePanel(host, options);
      }
    } catch {
      if (!stopped)
        target.replaceChildren(
          ErrorState({
            message: t(options.locale, "shell.unavailableDescription"),
            retryLabel: t(options.locale, "common.retry"),
            onRetry: () => void load(),
          }),
        );
    }
  };
  void load();
  return () => {
    stopped = true;
    dispose?.();
  };
}
export function createCollectionScreen() {
  const lazy = createLazyScreen();
  return {
    dispose: lazy.dispose,
    render(host: HTMLElement, options: Parameters<typeof showCollection>[1]) {
      lazy.render(host, {
        ...options,
        title: t(options.locale, "profile.collection"),
        brand: t(options.locale, "shell.brand"),
        load: async () => {
          const module = await collection();
          return () => module.showCollection(host, options);
        },
      });
    },
  };
}
