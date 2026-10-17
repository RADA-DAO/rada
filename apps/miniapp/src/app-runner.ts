import type { Locale } from "../../../packages/i18n/src/index.ts";
import type {
  initializePlatform,
  Navigation,
} from "../../../packages/platform-sdk/src/index.ts";
import type { AppRelease } from "../../../packages/platform-sdk/src/app-host.ts";
import { createChunkLoader } from "./chunk-loader.ts";
const loadHost = createChunkLoader(
  () => import("./community-app.ts"),
  "community-app",
);

/** The single running app: one "app" stack entry, replaced by the next mount. */
export function createAppRunner(options: {
  navigation: Navigation;
  platform: ReturnType<typeof initializePlatform>;
  locale(): Locale;
  back(): void;
  /** The app left the stack, by Back or by closing itself. */
  onClosed(): void;
  /** Back popped the app; the shell repaints its destination. */
  onLeave(): void;
}) {
  const { navigation, platform } = options;
  let activeAppDispose: (() => void) | undefined;
  let pendingAppMount: AbortController | undefined;
  let appHostGeneration = 0;
  function close() {
    appHostGeneration++;
    pendingAppMount?.abort();
    pendingAppMount = undefined;
    activeAppDispose?.();
    activeAppDispose = undefined;
  }
  function dismiss() {
    close();
    options.onClosed();
    navigation.drop("app");
  }
  /** Apps opened from the launcher take the edge swipe; review previews do not. */
  async function mount(
    release: AppRelease,
    container: HTMLElement,
    artifactOrigin: string,
    edgeBack = false,
  ): Promise<() => void> {
    close();
    const generation = appHostGeneration;
    const controller = new AbortController();
    pendingAppMount = controller;
    navigation.push({
      key: "app",
      ...(edgeBack ? { edgeBack: true } : {}),
      leave: () => {
        close();
        options.onClosed();
        options.onLeave();
      },
    });
    const locale = options.locale();
    const dispose = await (async () => {
      const { mountCommunityApp } = await loadHost();
      if (controller.signal.aborted) throw new Error("app_replaced");
      return mountCommunityApp({
        platform,
        navigation,
        release,
        container,
        artifactOrigin,
        locale,
        signal: controller.signal,
        back: () => {
          options.back();
        },
      });
    })().catch((error: unknown) => {
      if (pendingAppMount === controller) {
        pendingAppMount = undefined;
        navigation.drop("app");
      }
      throw error;
    });
    if (generation !== appHostGeneration) {
      dispose();
      throw new Error("app_replaced");
    }
    activeAppDispose = dispose;
    pendingAppMount = undefined;
    return () => {
      if (activeAppDispose !== dispose) return;
      dismiss();
    };
  }
  return {
    mount,
    dismiss,
    expose() {
      window.RadaAppHost = Object.freeze({
        mount: (release, container, origin) =>
          mount(release, container, origin),
      });
    },
  };
}
