import type { AppRelease } from "../../../packages/platform-sdk/src/app-host.ts";

declare global {
  interface Window {
    RadaAppHost?: {
      mount(
        release: AppRelease,
        container: HTMLElement,
        artifactOrigin: string,
      ): Promise<() => void>;
    };
  }
}
