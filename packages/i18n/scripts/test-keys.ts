import assert from "node:assert/strict";
import { t, type MessageKey } from "../src/index.ts";

const plain: MessageKey = "common.retry";
const plural: MessageKey = "state.items";
assert.equal(typeof t("en", plain), "string");
assert.equal(t("en", plural, { count: 2 }), "2 items");

// @ts-expect-error A namespace is not a message key.
const namespace: MessageKey = "common";
void namespace;
