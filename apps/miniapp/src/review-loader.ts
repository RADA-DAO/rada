import { createChunkLoader } from "./chunk-loader.ts";
import { ErrorState, Loading } from "../../../packages/ui/src/index.ts";
import { t } from "../../../packages/i18n/src/index.ts";
import type { mountReview } from "./review.ts";
const panel = createChunkLoader(() => import("./review.ts"), "review");
export function mountLazyReview(
  host: HTMLElement,
  options: Parameters<typeof mountReview>[1],
) {
  let stopped = false;
  let dispose: (() => void) | undefined;
  const target = host;
  const load = async () => {
    target.replaceChildren(
      Loading({ message: t(options.locale, "common.loading") }),
    );
    try {
      const module = await panel();
      if (!stopped) {
        target.replaceChildren();
        dispose = module.mountReview(host, options);
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
