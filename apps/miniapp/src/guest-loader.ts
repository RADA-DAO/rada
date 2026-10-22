import type { Locale } from "../../../packages/i18n/src/index.ts";

/** Keep entry styles out of the authenticated workspace's first paint. */
export function mountGuest(host: HTMLElement, locale: Locale) {
  return import("./guest.ts").then(({ mountGuest }) => {
    mountGuest(host, locale);
  });
}
