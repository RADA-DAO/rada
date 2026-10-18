import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import {
  emptyLayout,
  type LauncherSnapshot,
  type LauncherActivity,
} from "../../../packages/platform-sdk/src/launcher-layout.ts";
function auth(id: number) {
  const data = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id }),
  });
  const key = createHmac("sha256", "WebAppData")
    .update("synthetic-fixture-bot-token")
    .digest();
  data.set(
    "hash",
    createHmac("sha256", key)
      .update(
        [...data]
          .sort()
          .map(([k, v]) => `${k}=${v}`)
          .join("\n"),
      )
      .digest("hex"),
  );
  return { Authorization: `tma ${data}` };
}
test("real launcher API keeps layout and recent private and serializes concurrent saves", async ({
  request,
}) => {
  test.skip(!process.env.E2E_DATABASE_URL, "Disposable PostgreSQL required");
  const base = "http://127.0.0.1:8000/apps/launcher";
  const owner = auth(101),
    other = auth(102);
  const read = async (headers: { Authorization: string }) => {
    const response = await request.get(`${base}/layout`, { headers });
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    return (await response.json()) as LauncherSnapshot;
  };
  const before = await read(owner),
    privateOther = await read(other);
  const layout = { ...emptyLayout(), favourites: ["builtin:holders"] };
  const results = await Promise.all(
    [1, 2].map(() =>
      request.post(`${base}/layout`, {
        headers: owner,
        data: { version: before.version, layout },
      }),
    ),
  );
  expect(results.map((r) => r.status()).sort()).toEqual([200, 409]);
  expect((await read(owner)).layout).toEqual(layout);
  expect(await read(other)).toEqual(privateOther);
  const previous = await request.get(`${base}/activity`, { headers: other });
  const otherRecent = ((await previous.json()) as LauncherActivity).recent;
  expect(
    (
      await request.post(`${base}/activity`, {
        headers: owner,
        data: { appId: "builtin:holders" },
      })
    ).status(),
  ).toBe(200);
  const after = await request.get(`${base}/activity`, { headers: other });
  expect(((await after.json()) as LauncherActivity).recent).toEqual(
    otherRecent,
  );
  expect((await request.get(`${base}/layout`)).status()).toBe(401);
  expect(
    (
      await request.post(`${base}/layout`, {
        headers: owner,
        data: { version: before.version + 1, layout, subject: "other" },
      })
    ).status(),
  ).toBe(400);
  await request.post(`${base}/layout`, {
    headers: owner,
    data: { version: before.version + 1, layout: before.layout },
  });
});
