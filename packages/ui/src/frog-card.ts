import {
  applyTheme,
  compileTheme,
  DEFAULT_THEME_BACKGROUND,
  contrastRatio,
} from "./index.ts";
import {
  FROG_CARD_ASPECT_RATIO,
  FROG_CARD_CUTOUT_PATH,
  frogCardName,
} from "./frog-card-standard.ts";
export { frogCardName } from "./frog-card-standard.ts";

/** Adapted from the canonical JPEGPE card renderer; no legacy token HUD. */
export function FrogCard(
  model: {
    username: string;
    background_color: string | null;
    accent_color: string | null;
  },
  options: { missingArtLabel: string; image?: { url: string; alt: string } },
): HTMLElement {
  const card = document.createElement("article");
  card.className = "jpegpe-card jpegpe-card--hero jpegpe-card--cutout";
  card.style.aspectRatio = FROG_CARD_ASPECT_RATIO;
  const palette = compileTheme(
    model.background_color ?? DEFAULT_THEME_BACKGROUND,
    model.accent_color,
  );
  applyTheme(card, palette);
  const background = palette.tokens["--theme-base"];
  card.style.setProperty("--frog-card-bg", background);
  if (model.accent_color && /^#[0-9a-f]{6}$/i.test(model.accent_color))
    card.style.setProperty(
      "--frog-card-accent",
      model.accent_color.toUpperCase(),
    );
  const semanticInk = palette.tokens["--ink"];
  card.style.setProperty(
    "--frog-card-ink",
    contrastRatio(semanticInk, background) >= 4.5
      ? semanticInk
      : contrastRatio("#FFFFFF", background) >=
          contrastRatio("#000000", background)
        ? "#FFFFFF"
        : "#000000",
  );
  const plane = document.createElement("span");
  plane.className = "frog-card-plane";
  plane.setAttribute("aria-hidden", "true");
  const mask = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 125' preserveAspectRatio='none'><path fill='white' d='${FROG_CARD_CUTOUT_PATH}'/></svg>`)}")`;
  plane.style.maskImage = mask;
  const artwork = document.createElement("span");
  artwork.className = "frog-card-artwork";
  artwork.style.maskImage = mask;
  artwork.style.maskSize = "100% 100%";
  if (options.image) {
    const url = new URL(options.image.url, location.origin);
    if (
      url.origin !== location.origin ||
      url.search ||
      url.hash ||
      !/^\/media\/jpegpe\/[0-9a-f]{64}\.(webp|png)$/.test(url.pathname)
    )
      throw new Error("invalid_artwork");
    const image = document.createElement("img");
    image.className = "frog-card-art";
    image.src = url.href;
    image.alt = options.image.alt;
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener(
      "error",
      () => {
        const missing = document.createElement("small");
        missing.textContent = options.missingArtLabel;
        artwork.replaceChildren(missing);
      },
      { once: true },
    );
    artwork.append(image);
  } else {
    const missing = document.createElement("small");
    missing.textContent = options.missingArtLabel;
    artwork.append(missing);
  }
  const overlay = document.createElement("span");
  overlay.className = "frog-card-overlay";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.maskImage = mask;
  overlay.style.maskSize = "100% 100%";
  const name = document.createElement("strong");
  name.className = "frog-card-username";
  name.textContent = frogCardName(model.username);
  card.append(plane, artwork, overlay, name);
  return card;
}
