/** WebKit remembers failed module fetches. Retry with a fresh, build-owned URL. */
export function createChunkLoader<T>(load: () => Promise<T>, name: string) {
  let failures = 0;
  let loaded: T | undefined;
  return async (): Promise<T> => {
    if (loaded) return loaded;
    try {
      await import("@rada/ui/screens/secondary.css");
      if (!failures) loaded = await load();
      else {
        const response = await fetch(
          new URL("screen-chunks.json", document.baseURI),
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error("Screen map unavailable");
        const files = (await response.json()) as Record<string, string>;
        const file = files[name];
        if (!file?.startsWith("assets/") || file.includes(".."))
          throw new Error("Screen unavailable");
        const url = new URL(file, document.baseURI);
        url.searchParams.set("retry", String(failures));
        loaded = (await import(/* @vite-ignore */ url.href)) as T;
      }
      return loaded;
    } catch (error) {
      failures++;
      throw error;
    }
  };
}
