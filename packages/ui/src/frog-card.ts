import { loadFrogArtwork } from "./frog-artwork.ts";
import {
  compileTheme,
  DEFAULT_THEME_BACKGROUND,
  contrastRatio,
} from "./theme-compiler.ts";
import { applyTheme } from "./apply-theme.ts";
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
  options: {
    missingArtLabel: string;
    image?: { url: string; alt: string };
    artwork?: { load(signal: AbortSignal): Promise<Blob>; signal: AbortSignal };
  },
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
  if (options.artwork) {
    loadFrogArtwork(artwork, {
      ...options.artwork,
      alt: frogCardName(model.username),
      missingArtLabel: options.missingArtLabel,
    });
  } else if (options.image) {
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

/** Wide RADA OS identity banner, independent of collectible card geometry. */
export function ProfileFrogCard(
  model: Parameters<typeof FrogCard>[0] | null,
  options: Parameters<typeof FrogCard>[1] & { emptyLabel: string },
): HTMLElement {
  const card = document.createElement("article");
  card.className = "rada-profile-banner";
  if (model) {
    applyTheme(
      card,
      compileTheme(
        model.background_color ?? DEFAULT_THEME_BACKGROUND,
        model.accent_color,
      ),
    );
    if (model.accent_color)
      card.style.setProperty("--profile-frog-accent", model.accent_color);
    const artwork = document.createElement("span");
    artwork.className = "rada-profile-portrait";
    if (options.artwork)
      loadFrogArtwork(artwork, {
        ...options.artwork,
        alt: frogCardName(model.username),
        missingArtLabel: options.missingArtLabel,
        accessiblePlaceholderOnly: true,
      });
    else {
      artwork.setAttribute("role", "img");
      artwork.setAttribute("aria-label", options.missingArtLabel);
    }
    card.append(artwork);
  }
  const name = document.createElement("strong");
  name.className = "rada-profile-name";
  name.textContent = model ? frogCardName(model.username) : options.emptyLabel;
  card.append(name);
  return card;
}

export function profileActionIcon(
  button: HTMLButtonElement,
  kind:
    | "wallet"
    | "notifications"
    | "appearance"
    | "collection"
    | "permissions"
    | "profile",
): HTMLButtonElement {
  const paths = {
    wallet:
      "M4 7V5a2 2 0 0 1 2-2h12v4M4 7h15a1 1 0 0 1 1 1v3M4 7v12a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-4m0-5h-5v5h5v-5Z",
    notifications: "M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3Zm5 3h4",
    appearance:
      "M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-4c-1-1 0-2 1-2h2a4 4 0 0 0 4-4c0-5-4-8-9-8ZM7 9h.01M10 6h.01M15 7h.01M6 13h.01",
    collection: "m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 9 9-4M12 12 3 8m9 4v10",
    permissions: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6",
    profile: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0",
  };
  button.setAttribute(
    "aria-label",
    button.getAttribute("aria-label") ?? button.textContent,
  );
  delete button.dataset.icon;
  button.classList.add("rada-profile-action");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[kind]);
  svg.append(path);
  button.replaceChildren(svg);
  return button;
}
