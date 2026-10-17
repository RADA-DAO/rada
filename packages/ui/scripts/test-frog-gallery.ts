import assert from "node:assert/strict";
import { test } from "node:test";
import { fake } from "./fake-dom.ts";
import { FrogGallery, Group } from "../src/index.ts";
import { loadFrogArtwork } from "../src/frog-artwork.ts";
await test("gallery exposes native card targets and selected state", () => {
  let opened = 0;
  const gallery = fake(
    FrogGallery({
      label: "Collection",
      size: "compact",
      items: [
        {
          card: Group(),
          label: "Open Frog",
          selected: true,
          onOpen: () => {
            opened++;
          },
        },
      ],
    }),
  );
  assert.equal(gallery.tagName, "ul");
  assert.equal(gallery.dataset.size, "compact");
  const button = gallery.child(0).child(0);
  assert.equal(button.getAttribute("aria-label"), "Open Frog");
  assert.equal(button.getAttribute("aria-current"), "true");
  button.dispatch("click");
  assert.equal(opened, 1);
});
await test("authenticated artwork handles failure and ignores a disposed read", async () => {
  const target = Group();
  const controller = new AbortController();
  loadFrogArtwork(target, {
    alt: "Frog",
    missingArtLabel: "Unavailable",
    signal: controller.signal,
    load: () => Promise.reject(new Error("offline")),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fake(target).textContent, "Unavailable");
  let finish!: (blob: Blob) => void;
  const pending = new Promise<Blob>((resolve) => {
    finish = resolve;
  });
  loadFrogArtwork(target, {
    alt: "Frog",
    missingArtLabel: "Unavailable",
    signal: controller.signal,
    load: () => pending,
  });
  controller.abort();
  finish(new Blob());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    fake(target).children.some((child) => child.tagName === "img"),
    false,
  );
});
