import assert from "node:assert/strict";
import { test } from "node:test";
import { loadAppIcon } from "../src/app-icon.ts";
import { APP_ICON_MAX_BYTES } from "../../../packages/platform-sdk/src/app-manifest.ts";

// Minimal dimension headers; decoding and image-error fallback belong to the browser.
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
function webp(format: string, width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(format === "VP8L" ? 26 : 30);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    bytes.set(new TextEncoder().encode(value), offset);
  };
  write(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  write(8, "WEBP");
  write(12, format);
  view.setUint32(16, format === "VP8L" ? 5 : 10, true);
  if (format === "VP8X") {
    view.setUint16(24, width - 1, true);
    view.setUint16(27, height - 1, true);
  } else if (format === "VP8L") {
    bytes[20] = 0x2f;
    view.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  } else {
    bytes.set([157, 1, 42], 23);
    view.setUint16(26, width, true);
    view.setUint16(28, height, true);
  }
  return bytes;
}
const svg = (attributes: string) =>
  new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}/>`,
  );

await test("PNG and all WebP headers enforce square, positive sides up to 1024", async (t) => {
  const fixtures = [
    { name: "PNG", type: "image/png", make: png },
    ...["VP8 ", "VP8L", "VP8X"].map((format) => ({
      name: format,
      type: "image/webp",
      make: (width: number, height: number) => webp(format, width, height),
    })),
  ];
  for (const fixture of fixtures) {
    await t.test(fixture.name, async (t) => {
      t.mock.method(globalThis, "fetch", () =>
        Promise.resolve(
          new Response(
            new Blob([Uint8Array.from(body)], { type: fixture.type }),
          ),
        ),
      );
      const objectUrl = t.mock.method(
        URL,
        "createObjectURL",
        () => "blob:icon",
      );
      let body = fixture.make(1, 1);
      for (const side of [1, 64, 1024]) {
        body = fixture.make(side, side);
        assert.equal(
          await loadAppIcon(
            "https://icons.invalid/icon",
            new AbortController().signal,
          ),
          "blob:icon",
        );
      }
      assert.equal(objectUrl.mock.callCount(), 3);
      for (const [width, height] of [
        [64, 32],
        [32, 64],
        [1025, 1025],
      ]) {
        body = fixture.make(width ?? 0, height ?? 0);
        assert.equal(
          await loadAppIcon(
            "https://icons.invalid/icon",
            new AbortController().signal,
          ),
          undefined,
        );
      }
      for (const truncated of [
        new Uint8Array(),
        body.slice(0, 24),
        new Uint8Array(33),
      ]) {
        body = truncated;
        assert.equal(
          await loadAppIcon(
            "https://icons.invalid/icon",
            new AbortController().signal,
          ),
          undefined,
        );
      }
      assert.equal(
        objectUrl.mock.callCount(),
        3,
        "rejected icons keep the monogram without creating a URL",
      );
    });
  }
});

await test("SVG requires square viewBox or explicit pixel dimensions", async (t) => {
  let body = svg('viewBox="0 0 64 64"');
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      new Response(
        new Blob([Uint8Array.from(body)], { type: "image/svg+xml" }),
      ),
    ),
  );
  const objectUrl = t.mock.method(URL, "createObjectURL", () => "blob:icon");
  const load = () =>
    loadAppIcon("https://icons.invalid/icon", new AbortController().signal);
  const valid = [
    'viewBox="0 0 64 64"',
    'viewBox="-2, -2, 1024, 1024"',
    "width='64' height='64'",
    'width="1024px" height="1024px"',
    'viewBox="0 0 1e2 100" width="64" height="64"',
  ];
  for (const attributes of valid) {
    body = svg(attributes);
    assert.equal(await load(), "blob:icon", attributes);
  }
  body = new TextEncoder().encode(
    '<?xml version="1.0"?><!-- icon --><svg viewBox="0 0 64 64"></svg>',
  );
  assert.equal(await load(), "blob:icon");
  const accepted = objectUrl.mock.callCount();
  for (const attributes of [
    "",
    'viewBox="0 0 64 32"',
    'viewBox="0 0 1025 1025"',
    'viewBox="0 0 0 0"',
    'viewBox="0 0 -64 -64"',
    'viewBox="0 0 Infinity Infinity"',
    'viewBox="0 0 64"',
    'width="64" height="32"',
    'width="1025" height="1025"',
    'width="0" height="0"',
    'width="100%" height="100%"',
    'viewBox="0 0 64 64" width="2048" height="2048"',
    'width="64"',
    'viewBox="0 0 32 64" width="64" height="64"',
    'viewBox="0 0 64 64" viewBox="0 0 32 64"',
  ]) {
    body = svg(attributes);
    assert.equal(await load(), undefined, attributes);
  }
  for (const source of [
    '<!-- <svg viewBox="0 0 64 64"> -->',
    '<html><svg viewBox="0 0 64 64"/></html>',
  ]) {
    body = new TextEncoder().encode(source);
    assert.equal(await load(), undefined);
  }
  assert.equal(objectUrl.mock.callCount(), accepted);
});

await test("unavailable, oversized, unsupported and corrupt icons preserve the monogram", async (t) => {
  let response = new Response(null, { status: 404 });
  const fetch = t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(response),
  );
  const objectUrl = t.mock.method(URL, "createObjectURL", () => "blob:icon");
  const signal = new AbortController().signal;
  for (const next of [
    response,
    new Response(Uint8Array.from(png(0, 0)), {
      headers: { "content-type": "image/png" },
    }),
    new Response(Uint8Array.from(png(64, 64)), {
      headers: { "content-type": "image/gif" },
    }),
    new Response(Uint8Array.from(png(64, 64)), {
      headers: { "content-type": "image/webp" },
    }),
    new Response(Uint8Array.from(png(64, 64)), {
      headers: { "content-length": String(APP_ICON_MAX_BYTES + 1) },
    }),
    new Response(new Uint8Array(APP_ICON_MAX_BYTES + 1), {
      headers: { "content-type": "image/png" },
    }),
    new Response(new Uint8Array([255]), {
      headers: { "content-type": "image/svg+xml" },
    }),
  ]) {
    response = next;
    assert.equal(
      await loadAppIcon("https://icons.invalid/icon", signal),
      undefined,
    );
  }
  fetch.mock.mockImplementation(() =>
    Promise.reject(new Error("offline or aborted")),
  );
  assert.equal(
    await loadAppIcon("https://icons.invalid/icon", signal),
    undefined,
  );
  assert.equal(objectUrl.mock.callCount(), 0);
  assert.deepEqual(fetch.mock.calls[0]?.arguments[1], {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  });
});
