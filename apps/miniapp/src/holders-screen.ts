import { createChunkLoader } from "./chunk-loader.ts";
import { createLazyScreen } from "./lazy-screen.ts";
import type { showHolders } from "./holders.ts";

export function createHoldersScreen() {
  const lazy = createLazyScreen();
  const load = createChunkLoader(() => import("./holders.ts"), "holders");
  return {
    dispose: lazy.dispose,
    render(
      host: HTMLElement,
      options: Parameters<typeof showHolders>[1] & {
        title: string;
        brand: string;
        actions: Node[];
      },
    ) {
      lazy.render(host, {
        ...options,
        load: async () => {
          const { showHolders } = await load();
          return () => showHolders(host, options, options.actions);
        },
      });
    },
  };
}
