import test from "node:test";
import assert from "node:assert/strict";
import {
  DIAGNOSTIC_CODES,
  buildReport,
} from "../../../packages/platform-sdk/src/client-errors.ts";
import { DIAGNOSTIC_CODES as SERVER_CODES, parseReport } from "./sanitize.ts";

const ctx = {
  origin: "https://app.example",
  build: "abc1234",
  route: "launcher",
};

await test("SDK codes match the server and survive report parsing", () => {
  assert.deepEqual(DIAGNOSTIC_CODES, SERVER_CODES);
  const error = new TypeError("Example Person example_person");
  error.stack = "TypeError\n at https://app.example/main.js:2:3";
  const report = buildReport("error", error, ctx);
  assert.deepEqual(parseReport(report), report);
  for (const message of [
    "Example Person",
    "example_person",
    "",
    "type_error ",
    null,
  ]) {
    assert.equal(parseReport({ ...report, message }), null);
  }
});
