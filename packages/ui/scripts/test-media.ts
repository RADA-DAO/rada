import assert from "node:assert/strict";
import { test } from "node:test";
import { fake } from "./fake-dom.ts";
import {
  Badge,
  Countdown,
  Facts,
  FilePicker,
  Picture,
  Text,
} from "../src/index.ts";

await test("Picture shows artwork with alt text and a fallback on error", () => {
  const picture = fake(
    Picture({
      src: "/a.png",
      alt: "Frog",
      fallback: "No image",
      size: "thumb",
    }),
  );
  assert.equal(picture.tagName, "figure");
  assert.ok(picture.classList.contains("rada-picture--thumb"));
  const image = picture.child(0);
  assert.equal(image.tagName, "img");
  assert.equal(image.alt, "Frog");
  assert.equal(image.src, "/a.png");
  image.dispatch("error");
  assert.equal(picture.child(0).tagName, "figcaption");
  assert.equal(picture.textContent, "No image");
});

await test("FilePicker reports the chosen file and resets the input", () => {
  const chosen: unknown[] = [];
  const picker = FilePicker({
    label: "Choose image",
    accept: "image/png",
    onSelect: (file) => chosen.push(file),
  });
  const label = fake(picker.element);
  const input = fake(picker.input) as ReturnType<typeof fake> & {
    files?: unknown[];
    accept?: string;
  };
  assert.equal(label.tagName, "label");
  assert.equal(label.child(0), input);
  assert.equal(input.type, "file");
  assert.equal(input.accept, "image/png");
  assert.equal(label.textContent, "Choose image");
  input.files = ["file"];
  input.value = "C:\\fakepath\\frog.png";
  input.dispatch("change");
  assert.deepEqual(chosen, ["file"]);
  assert.equal(input.value, "");
  input.files = [];
  input.dispatch("change");
  assert.equal(chosen.length, 1, "no file, no report");
});

await test("Facts and Badge render labelled values", () => {
  const facts = fake(
    Facts([
      { label: "Participants", value: "12" },
      { label: "Note", value: Text("Body") },
    ]),
  );
  assert.equal(facts.tagName, "dl");
  assert.equal(facts.child(0).child(0).tagName, "dt");
  assert.equal(facts.child(0).textContent, "Participants12");
  assert.equal(facts.child(1).child(1).child(0).tagName, "p");
  assert.equal(fake(Badge("Won")).className, "rada-badge");
  assert.match(fake(Badge("Burned", { tone: "strong" })).className, /strong/);
});

await test("Countdown is a timer that ends once and can be disposed", async () => {
  let now = 10_000;
  let ended = 0;
  const countdown = Countdown({
    until: 12_000,
    label: "Time left",
    format: (remaining) => `${String(remaining / 1000)}s`,
    onEnd: () => ended++,
    now: () => now,
  });
  const timer = fake(countdown.element);
  assert.equal(timer.getAttribute("role"), "timer");
  assert.equal(timer.getAttribute("aria-label"), "Time left");
  assert.equal(timer.textContent, "2s");
  now = 13_000;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(timer.textContent, "0s");
  assert.equal(ended, 1);
  countdown.dispose();
  const past = Countdown({
    until: 0,
    label: "Ended",
    format: () => "done",
    onEnd: () => ended++,
  });
  assert.equal(fake(past.element).textContent, "done");
  assert.equal(ended, 1, "a time already past is not an end");
  past.dispose();
});
