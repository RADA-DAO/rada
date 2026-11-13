import test from "node:test";
import assert from "node:assert/strict";
import { appHostLayer } from "./app-host-layers.ts";
import { createNavigation } from "./navigation.ts";

void test("a child modal owns one generated host entry and Back dismisses exactly once", () => {
  let dismissed = 0;
  const navigation = createNavigation({ key: "app" });
  const layer = appHostLayer({
    key: "host-generated-id",
    navigation,
    dismiss() {
      dismissed++;
    },
  });
  assert.deepEqual(layer.open(), { opened: true });
  layer.open();
  assert.deepEqual(navigation.keys, ["app", "host-generated-id"]);
  assert.equal(navigation.top.stale?.(), false);
  navigation.back();
  assert.equal(dismissed, 1);
  assert.deepEqual(navigation.keys, ["app"]);
  layer.close();
  layer.close();
  assert.deepEqual(navigation.keys, ["app"]);
  navigation.dispose();
});

void test("child close/disposal cannot unwind a host permission or settings entry", () => {
  let hostDismissed = 0;
  const navigation = createNavigation({ key: "app" });
  const layer = appHostLayer({ key: "child-layer", navigation, dismiss() {} });
  layer.open();
  navigation.push({
    key: "host-permission",
    leave() {
      hostDismissed++;
    },
  });
  layer.close();
  assert.deepEqual(navigation.keys, ["app", "child-layer", "host-permission"]);
  assert.deepEqual(layer.open(), { opened: false });
  assert.equal(hostDismissed, 0);
  navigation.back();
  assert.equal(hostDismissed, 1);
  assert.equal(navigation.top.key, "child-layer");
  assert.equal(navigation.top.stale?.(), true);
  layer.close();
  assert.deepEqual(navigation.keys, ["app"]);
  navigation.dispose();
});

void test("a frame cannot install a layer after navigation leaves its captured app", () => {
  const navigation = createNavigation({ key: "app" });
  const layer = appHostLayer({ key: "child-layer", navigation, dismiss() {} });
  navigation.push({ key: "host-settings" });
  assert.deepEqual(layer.open(), { opened: false });
  layer.close();
  assert.deepEqual(navigation.keys, ["app", "host-settings"]);
  navigation.dispose();
  assert.deepEqual(appHostLayer({ key: "no-nav", dismiss() {} }).open(), {
    opened: false,
  });
  assert.deepEqual(
    appHostLayer({
      key: "minimal-nav",
      navigation: {
        push() {},
        drop() {
          assert.fail("No top authority");
        },
      },
      dismiss() {},
    }).open(),
    { opened: false },
  );
});
