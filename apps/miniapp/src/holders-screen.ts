import { createChunkLoader } from "./chunk-loader.ts";
import { createLazyScreen } from "./lazy-screen.ts";
import type { showHolders } from "./holders.ts";

export function createHoldersScreen(community = false) {
  const lazy = createLazyScreen();
  const load = createChunkLoader(
    () => import("./desktop-screens.ts"),
    "holders",
  );
  return {
    dispose: lazy.dispose,
    render(
      host: HTMLElement,
      options: Parameters<typeof showHolders>[1] & {
        active?: boolean;
        title: string;
        brand: string;
        actions: Node[];
      },
    ) {
      lazy.render(host, {
        ...options,
        load: async () => {
          const { showHolders, showCommunity } = await load();
          return () =>
            community
              ? showCommunity(host, options)
              : showHolders(host, options, options.actions);
        },
      });
    },
  };
}
