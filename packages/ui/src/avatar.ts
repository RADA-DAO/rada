import { element } from "./dom.ts";

/** Round identity mark: the picture when it loads, otherwise initials. */
export function Avatar(options: {
  name: string;
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
