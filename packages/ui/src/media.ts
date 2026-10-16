import { element } from "./dom.ts";

/**
 * A picture with alternative text, such as uploaded artwork. Transparent areas
 * show the surface behind it. When it cannot load, `fallback` replaces it.
 */
export function Picture(options: {
  src: string;
  alt: string;
  fallback: string;
  size?: "thumb" | "full";
}): HTMLElement {
  const figure = element(
    "figure",
    options.size === "thumb"
      ? "rada-picture rada-picture--thumb"
      : "rada-picture",
  );
  const image = element("img", "rada-picture-image");
  image.alt = options.alt;
  image.src = options.src;
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener(
    "error",
    () => {
      figure.replaceChildren(
        element("figcaption", "rada-picture-missing", options.fallback),
      );
    },
    { once: true },
  );
  figure.append(image);
  return figure;
}

/**
 * Choose one file. The native input stays in the page for keyboard and screen
 * reader use; its label is drawn as a secondary button.
 */
export function FilePicker(options: {
  label: string;
  /** Accepted media types, for example `image/png,image/jpeg`. */
  accept: string;
  onSelect: (file: File) => void;
  disabled?: boolean;
}): { element: HTMLElement; input: HTMLInputElement } {
  const label = element("label", "rada-file-picker");
  const input = element("input", "rada-file-picker-input");
  input.type = "file";
  input.accept = options.accept;
  input.disabled = options.disabled ?? false;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    // Clear so choosing the same file again still reports it.
    input.value = "";
    if (file) options.onSelect(file);
  });
  label.append(input, element("span", "rada-file-picker-text", options.label));
  return { element: label, input };
}
