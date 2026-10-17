import { element } from "./dom.ts";

/** Round identity mark: artwork, a stable frog silhouette, or initials. */
export function Avatar(options: {
  name: string;
  /** Public frog ID: stable frog silhouette when artwork is unavailable. */
  frogId?: string;
  imageUrl?: string;
  size?: "small" | "medium";
  /** Accessible name. Leave out when the name is already shown beside it. */
  label?: string;
}): HTMLElement {
  const avatar = element(
    "span",
    options.size === "small" ? "rada-avatar rada-avatar--small" : "rada-avatar",
  );
  if (options.label) {
    avatar.setAttribute("role", "img");
    avatar.setAttribute("aria-label", options.label);
  } else avatar.setAttribute("aria-hidden", "true");
  const letters = new Intl.Segmenter().segment(options.name.trim());
  avatar.textContent = Array.from(letters, (part) => part.segment)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  if (options.frogId && !options.imageUrl) {
    const seed = Array.from(options.frogId).reduce(
      (sum, char) => sum + char.charCodeAt(0),
      0,
    );
    const pupil = 13 + (seed % 3);
    const frog = element("span", "rada-avatar-frog");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path fill="white" d="M8 18a7 7 0 1 1 12-7 7 7 0 1 1 12 7c6 16-30 16-24 0Z"/><circle cx="${String(pupil)}" cy="12" r="2" fill="black"/><circle cx="${String(pupil + 12)}" cy="12" r="2" fill="black"/><path d="M13 23q7 5 14 0" fill="none" stroke="black" stroke-width="2"/></svg>`;
    frog.setAttribute(
      "style",
      `mask-image: url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
    );
    avatar.replaceChildren(frog);
  }
  if (options.imageUrl) {
    const image = element("img", "rada-avatar-image");
    image.alt = "";
    image.src = options.imageUrl;
    image.addEventListener("error", () => {
      image.remove();
    });
    avatar.append(image);
  }
  return avatar;
}
