/** Lazy authenticated artwork, with a stable placeholder and scoped blob lifetime. */
export function loadFrogArtwork(
  artwork: HTMLElement,
  options: {
    alt: string;
    missingArtLabel: string;
    load(signal: AbortSignal): Promise<Blob>;
    signal: AbortSignal;
  },
): void {
  const placeholder = document.createElement("small");
  placeholder.textContent = options.missingArtLabel;
  artwork.append(placeholder);
  let url: string | undefined;
  let observer: IntersectionObserver | undefined;
  const release = () => {
    observer?.disconnect();
    if (url) URL.revokeObjectURL(url);
    url = undefined;
  };
  options.signal.addEventListener("abort", release, { once: true });
  const aborted = () => options.signal.aborted;
  const load = async () => {
    observer?.disconnect();
    if (aborted()) return;
    artwork.setAttribute("aria-busy", "true");
    try {
      const blob = await options.load(options.signal);
      if (aborted()) return;
      url = URL.createObjectURL(blob);
      const image = document.createElement("img");
      image.className = "frog-card-art";
      image.alt = options.alt;
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener(
        "error",
        () => {
          release();
          artwork.replaceChildren(placeholder);
        },
        { once: true },
      );
      image.src = url;
      artwork.replaceChildren(image);
    } catch {
      if (!aborted()) artwork.replaceChildren(placeholder);
    } finally {
      artwork.removeAttribute("aria-busy");
    }
  };
  if (typeof IntersectionObserver === "undefined") void load();
  else {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void load();
    });
    observer.observe(artwork);
  }
}
