import assert from "node:assert/strict";
import { test } from "node:test";
import { fake, fakeDocument } from "./fake-dom.ts";
import {
  RankingRow,
  Actions,
  Avatar,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  isSheetOpen,
  List,
  ListItem,
  Loading,
  openSheet,
  Screen,
  ScreenHost,
  Section,
  setButtonLoading,
  Sheet,
  Tabs,
  Text,
} from "../src/index.ts";

await test("Button variants, click and loading state", () => {
  let clicks = 0;
  const button = fake(Button("Open", { onClick: () => clicks++ }));
  button.click();
  assert.equal(clicks, 1);
  assert.equal(button.className, "rada-button rada-button--secondary");
  assert.equal(button.type, "button");
  assert.match(
    fake(Button("x", { variant: "primary" })).className,
    /--primary/,
  );
  assert.match(fake(Button("x", { variant: "ghost" })).className, /--ghost/);
  assert.equal(
    fake(Button("x", { ariaLabel: "Name" })).getAttribute("aria-label"),
    "Name",
  );

  const settings = Button("Settings", { icon: "settings" });
  assert.equal(settings.getAttribute("aria-label"), "Settings");
  assert.equal(settings.dataset.icon, "settings");
  assert.equal(settings.textContent, "");

  const busy = Button("Save", { disabled: true });
  setButtonLoading(busy, true);
  assert.equal(busy.disabled, true);
  assert.equal(busy.getAttribute("aria-busy"), "true");
  assert.equal(busy.dataset.loading, "true");
  setButtonLoading(busy, false);
  assert.equal(busy.disabled, true, "previous disabled state is restored");
  assert.equal(busy.getAttribute("aria-busy"), null);
  const enabled = Button("Save", { loading: true });
  assert.equal(enabled.disabled, true);
  setButtonLoading(enabled, false);
  assert.equal(enabled.disabled, false);
  const disabled = fake(
    Button("Go", { disabled: true, onClick: () => clicks++ }),
  );
  disabled.click();
  assert.equal(clicks, 1);
});

await test("Card, Section, Text and Actions", () => {
  const child = Text("Body", { live: "polite", breakAnywhere: true });
  const card = fake(Card({ label: "Summary", children: [child] }));
  assert.equal(card.getAttribute("aria-label"), "Summary");
  assert.equal(card.child(0), fake(child));
  assert.equal(fake(child).getAttribute("aria-live"), "polite");
  assert.ok(fake(child).classList.contains("rada-text--break"));
  const section = fake(Section({ title: "Wallet", children: [child] }));
  assert.equal(section.child(0).tagName, "h2");
  assert.equal(section.child(0).textContent, "Wallet");
  assert.equal(fake(Actions([Button("A"), Button("B")])).children.length, 2);
});

await test("states expose status and alert roles", () => {
  const empty = fake(EmptyState({ title: "None", message: "No entries" }));
  assert.equal(empty.getAttribute("role"), "status");
  assert.equal(empty.textContent, "NoneNo entries");
  let retries = 0;
  const error = fake(
    ErrorState({
      message: "Unavailable",
      retryLabel: "Retry",
      onRetry: () => retries++,
    }),
  );
  assert.equal(error.getAttribute("role"), "alert");
  error.child(1).click();
  assert.equal(retries, 1);
  assert.equal(
    fake(ErrorState({ message: "x", retryLabel: "Retry" })).children.length,
    1,
  );
  const loading = fake(Loading({ message: "Loading…" }));
  assert.equal(loading.getAttribute("role"), "status");
  assert.equal(loading.getAttribute("aria-busy"), "true");
  assert.equal(loading.textContent, "Loading…");
});

await test("Sheet is labelled by its heading and closes itself", () => {
  const sheet = fake(Sheet({ title: "Details", closeLabel: "Close" }));
  const header = sheet.child(0);
  assert.equal(sheet.getAttribute("aria-labelledby"), header.child(0).id);
  sheet.showModal();
  header.child(1).click();
  assert.equal(sheet.open, false);
});

await test("openSheet registers in the navigation stack and restores focus", () => {
  const log: string[] = [];
  const entries: { key: string; stale?(): boolean; leave?(): void }[] = [];
  const navigation = {
    push: (entry: (typeof entries)[number]) => {
      entries.push(entry);
      log.push(`push:${entry.key}`);
    },
    drop: (key: string) => {
      log.push(`drop:${key}`);
    },
  };
  const opener = Button("Settings");
  fakeDocument.body.append(fake(opener));
  const first = fake(
    openSheet({ title: "A", closeLabel: "Close", navigation, opener }),
  );
  assert.ok(isSheetOpen());
  assert.equal(first.parent, fakeDocument.body);
  // Platform Back closes the open sheet through the registered entry.
  assert.equal(entries.at(0)?.stale?.(), false);
  entries.at(0)?.leave?.();
  assert.equal(isSheetOpen(), false);
  assert.equal(entries.at(0)?.stale?.(), true);
  assert.equal(first.parent, undefined);
  assert.deepEqual(log, ["push:sheet", "drop:sheet"]);
  assert.equal(fakeDocument.activeElement, fake(opener));

  // Replacing a sheet must not let the old close event drop the new entry.
  log.length = 0;
  const old = fake(openSheet({ title: "A", closeLabel: "Close", navigation }));
  const next = fake(openSheet({ title: "B", closeLabel: "Close", navigation }));
  old.close();
  assert.equal(isSheetOpen(), true);
  assert.deepEqual(log, ["push:sheet", "push:sheet"]);
  next.close();
  assert.deepEqual(log.slice(2), ["drop:sheet"]);
});

await test("Screen composes header, title, body and footer without its own Back", () => {
  const footer = Tabs({ label: "Main", selected: "a", tabs: [] });
  const child = Text("Body");
  const view = fake(
    Screen({
      title: "Profile",
      brand: "RADA",
      actions: [Button("Settings")],
      children: [child],
      footer,
    }),
  );
  const header = view.child(0);
  const body = view.child(1);
  const foot = view.child(2);
  assert.equal(header.tagName, "header");
  // Only the Settings action: Back belongs to the platform.
  assert.equal(header.all("rada-button").length, 1);
  assert.equal(body.child(0).tagName, "h1");
  assert.equal(body.child(0).textContent, "Profile");
  assert.equal(body.child(1), fake(child));
  assert.equal(foot, fake(footer));
  const root = Screen({ title: "Apps" });
  assert.equal(fake(root).all("rada-button").length, 0);
  const host = fake(ScreenHost(fake(Card()) as unknown as HTMLElement));
  assert.equal(host.className, "screen");
  assert.equal(host.parent?.className, "screen-wrap");
});

await test("List and ListItem", () => {
  const action = Button("Revoke");
  const raw = ListItem({
    title: "App",
    heading: true,
    titleHint: "app.id",
    description: "Reads address",
    leading: Avatar({ name: "app" }),
    actions: [action],
  });
  const item = fake(raw);
  assert.equal(item.tagName, "li");
  assert.equal(item.child(0).className, "rada-avatar");
  const main = item.child(1);
  assert.equal(main.child(0).tagName, "h2");
  assert.equal(main.child(0).title, "app.id");
  assert.equal(main.child(2).child(0), fake(action));
  assert.equal(
    fake(ListItem({ title: "Plain" })).all("rada-list-item-title")[0]?.tagName,
    "p",
  );
  const list = fake(List({ label: "Apps", children: [raw], marked: true }));
  assert.equal(list.tagName, "ul");
  assert.equal(list.getAttribute("aria-label"), "Apps");
  assert.ok(list.classList.contains("rada-list--marked"));
});

await test("Field labels its control and reports errors accessibly", () => {
  const changes: string[] = [];
  const area = Field({
    label: "Reason",
    kind: "textarea",
    maxLength: 500,
    rows: 3,
    required: true,
    onChange: (value) => changes.push(value),
  });
  const control = fake(area.control);
  const label = fake(area.element).child(0);
  assert.equal(label.tagName, "label");
  assert.equal(label.child(0).textContent, "Reason");
  assert.equal(label.child(1), control);
  assert.equal(control.maxLength, 500);
  assert.equal(control.required, true);
  const error = fake(area.element).child(2);
  assert.equal(error.hidden, true);
  assert.equal(fake(area.element).child(1).hidden, true, "no hint yet");
  area.setError("Required");
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, "Required");
  assert.equal(control.getAttribute("aria-invalid"), "true");
  assert.equal(control.getAttribute("aria-describedby"), error.id);
  area.setError();
  assert.equal(control.getAttribute("aria-invalid"), null);
  assert.equal(control.getAttribute("aria-describedby"), null);
  control.value = "ok";
  control.dispatch("change");
  assert.deepEqual(changes, ["ok"]);

  const typed: string[] = [];
  const name = Field({
    label: "Name",
    inputMode: "decimal",
    hint: "Checking",
    onInput: (value) => typed.push(value),
  });
  const nameControl = fake(name.control);
  const hint = fake(name.element).child(1);
  assert.equal(nameControl.getAttribute("inputmode"), "decimal");
  assert.equal(hint.getAttribute("aria-live"), "polite");
  assert.equal(nameControl.getAttribute("aria-describedby"), hint.id);
  name.setError("Taken");
  assert.equal(
    nameControl.getAttribute("aria-describedby"),
    `${hint.id} ${fake(name.element).child(2).id}`,
  );
  name.setHint();
  name.setError();
  assert.equal(nameControl.getAttribute("aria-describedby"), null);
  nameControl.value = "Al";
  nameControl.dispatch("input");
  assert.deepEqual(typed, ["Al"]);

  const select = Field({
    label: "Language",
    kind: "select",
    value: "uk",
    choices: [
      { value: "en", label: "English" },
      { value: "uk", label: "Ukrainian" },
    ],
  });
  assert.equal(fake(select.control).tagName, "select");
  assert.deepEqual(
    fake(select.control).children.map((option) => option.value),
    ["en", "uk"],
  );
  assert.equal(fake(select.control).value, "uk");
  assert.equal(
    fake(Field({ label: "Name", error: "Bad" }).element).child(2).textContent,
    "Bad",
  );
});

await test("Tabs mark the current page and select", () => {
  const selected: string[] = [];
  const tabs = fake(
    Tabs({
      label: "Main",
      selected: "profile",
      tabs: ["apps", "profile"].map((id) => ({
        id,
        label: id,
        onSelect: () => selected.push(id),
      })),
    }),
  );
  assert.equal(tabs.tagName, "nav");
  assert.equal(tabs.getAttribute("aria-label"), "Main");
  assert.deepEqual(
    tabs.children.map((tab) => tab.getAttribute("aria-current")),
    ["false", "page"],
  );
  tabs.child(0).click();
  assert.deepEqual(selected, ["apps"]);
});

await test("Avatar falls back to initials", () => {
  const plain = fake(Avatar({ name: "wallet" }));
  assert.equal(plain.textContent, "WA");
  assert.equal(plain.getAttribute("aria-hidden"), "true");
  const named = fake(
    Avatar({ name: "frog", label: "Frog", imageUrl: "/a.png", size: "small" }),
  );
  assert.equal(named.getAttribute("role"), "img");
  assert.equal(named.getAttribute("aria-label"), "Frog");
  assert.ok(named.classList.contains("rada-avatar--small"));
  const image = named.child(0);
  assert.equal(image.src, "/a.png");
  image.dispatch("error");
  assert.equal(named.children.length, 0);
});

await test("ranking rows preserve exact values, freshness and viewer identity", () => {
  const options = {
    rank: "1",
    frogId: "00000000-0000-4000-8000-000000000001",
    name: "@frog",
    amount: "9,007,199,254.1234 TON",
    asOf: "As of 10:00",
  };
  const row = fake(
    RankingRow({
      ...options,
      staleLabel: "Older than 6 h",
      viewerLabel: "You",
    }),
  );
  assert.equal(row.tagName, "li");
  assert.equal(row.getAttribute("aria-current"), "true");
  assert.match(
    row.textContent,
    /@frogYou9,007,199,254.1234 TONAs of 10:00Older than 6 h/,
  );
  assert.equal(row.child(1).getAttribute("aria-hidden"), "true");
  const avatar = fake(Avatar({ name: options.name, frogId: options.frogId }));
  assert.equal(
    avatar.child(0).getAttribute("style"),
    row.child(1).child(0).getAttribute("style"),
  );
  assert.equal(fake(RankingRow(options)).getAttribute("aria-current"), null);
});
