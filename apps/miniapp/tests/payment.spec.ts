import { test, expect, type Page } from "@playwright/test";
import { createHash, createHmac } from "node:crypto";
import en from "../../../packages/i18n/locales/en.json" with { type: "json" };

const sender = `0:${"2".repeat(64)}`;
const recipient = `0:${"1".repeat(64)}`;
const intentId = "00000000-0000-4000-8000-000000000101";
const input = {
  idempotencyKey: "payment_fixture_101",
  token: "TON",
  amount: "1000000001",
  recipient,
  purpose: "Fixture payment",
};
function signed() {
  const data = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 101 }),
  });
  const secret = createHmac("sha256", "WebAppData")
    .update("synthetic-fixture-bot-token")
    .digest();
  data.set(
    "hash",
    createHmac("sha256", secret)
      .update(
        [...data.entries()]
          .sort()
          .map(([k, v]) => `${k}=${v}`)
          .join("\n"),
      )
      .digest("hex"),
  );
  return data.toString();
}
async function fixture(page: Page) {
  const credential = signed();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ body: "" }),
  );
  await page.addInitScript(
    ({ credential, sender }) => {
      if (window !== window.top) return;
      localStorage.setItem("fixture-ton-session", "restored");
      localStorage.setItem("fixture-ton-payment", "enabled");
      localStorage.setItem("fixture-ton-account", sender);
      const listeners = new Map<string, () => void>();
      Object.assign(window, {
        Telegram: {
          WebApp: {
            initData: credential,
            viewportHeight: innerHeight,
            ready() {},
            expand() {},
            setHeaderColor() {},
            setBackgroundColor() {},
            onEvent(name: string, cb: () => void) {
              listeners.set(name, cb);
            },
            offEvent(name: string) {
              listeners.delete(name);
            },
            BackButton: {
              show() {},
              hide() {},
              onClick(cb: () => void) {
                listeners.set("back", cb);
              },
              offClick() {
                listeners.delete("back");
              },
            },
          },
        },
        fixturePaymentBack: () => listeners.get("back")?.(),
      });
    },
    { credential, sender },
  );
  let status: "prepared" | "unknown" | "paid" | "cancelled" = "prepared";
  let claims = 0;
  let preparations = 0;
  let cancellations = 0;
  const payment = () => ({
    ...input,
    intentId,
    sender,
    status,
    network: "-239",
    gasBudget: null,
    feeEstimate: {
      nano: "1234567",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    },
  });
  await page.route("**/me", (route) =>
    route.fulfill({
      json: {
        subject_id: "fixture-subject",
        profile: { visibility: "private", public: null },
        membership: { status: "unavailable" },
      },
    }),
  );
  await page.route("**/payments**", async (route) => {
    const request = route.request();
    expect(request.headers()["authorization"]).toContain(credential);
    const url = new URL(request.url());
    if (url.pathname.endsWith("/payments")) {
      preparations++;
      expect(request.method()).toBe("POST");
      expect(request.postDataJSON()).toEqual({
        ...input,
        appId: "fixture.payment",
        sender,
      });
    } else {
      expect(url.searchParams.get("appId")).toBe("fixture.payment");
    }
    if (url.pathname.endsWith("/claim")) {
      claims++;
      expect(status).toBe("prepared");
      status = "unknown";
      await route.fulfill({
        json: {
          payment: payment(),
          signRequest: {
            network: "-239",
            from: sender,
            validUntil: Math.floor(Date.now() / 1000) + 60,
            messages: [
              {
                address: recipient,
                amount: input.amount,
                payload: "synthetic-comment",
              },
            ],
          },
        },
      });
      return;
    }
    if (url.pathname.endsWith("/cancel")) {
      cancellations++;
      status = "cancelled";
    }
    await route.fulfill({ json: { payment: payment() } });
  });
  await page.goto("/");
  const artifact = `<main><button id="request">Pay</button><button id="status">Status</button></main><script>
    document.body.dataset.origin = location.origin;
    let sequence = 0;
    function record(promise) {
      const id = ++sequence;
      promise.then(value => { document.body.dataset.result = JSON.stringify(value); document.body.dataset.done = String(id); })
        .catch(error => { document.body.dataset.result = error.message; document.body.dataset.done = String(id); });
    }
    document.querySelector('#request').onclick = () => record(rada.member.request('rada.member.payment.request', ${JSON.stringify(input)}));
    document.querySelector('#status').onclick = () => record(rada.member.request('rada.member.payment.status', { intentId: '${intentId}' }));
  </script>`;
  const hash = createHash("sha256").update(artifact).digest("hex");
  await page.route("**/payment-fixture.html", (route) =>
    route.fulfill({ contentType: "text/html", body: artifact }),
  );
  await page.evaluate(async (hash) => {
    const holder = document.createElement("div");
    document.body.append(holder);
    if (!window.RadaAppHost) throw new Error("App host unavailable");
    const dispose = await window.RadaAppHost.mount(
      {
        appId: "fixture.payment",
        artifactUrl: "http://127.0.0.1:4173/payment-fixture.html",
        artifactSha256: hash,
        manifest: {
          name: "Fixture",
          author: "Fixture",
          trustLevel: "official",
          designRoute: "free-style",
          permissions: ["money.transfer", "navigation"],
          minPlatformVersion: "1.0.0",
        },
        grantedPermissions: ["money.transfer", "navigation"],
      },
      holder,
      "http://127.0.0.1:4173",
    );
    Object.assign(window, { fixturePaymentDispose: dispose });
  }, hash);
  const frame = page.frameLocator("iframe[sandbox='allow-scripts']");
  await expect(frame.locator("body")).toHaveAttribute("data-origin", "null");
  return {
    frame,
    errors,
    counts: () => ({ claims, preparations, cancellations }),
    paid: () => {
      status = "paid";
    },
    sends: () =>
      page.evaluate(() =>
        Number(localStorage.getItem("fixture-ton-sends") ?? 0),
      ),
    request: () => frame.locator("#request").click(),
    result: async (status: string, sequence: number) => {
      await expect(frame.locator("body")).toHaveAttribute(
        "data-done",
        String(sequence),
      );
      await expect(frame.locator("body")).toHaveAttribute(
        "data-result",
        JSON.stringify({ intentId, status }),
      );
    },
  };
}

test("payment dialog displays exact values and cancellation never claims or sends", async ({
  page,
}) => {
  const f = await fixture(page);
  await f.request();
  const dialog = page.getByRole("dialog", { name: en.payment.title });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(`${en.payment.amount}: 1.000000001 TON`, { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText(`${en.payment.recipient}: ${recipient}`, { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText(`${en.payment.fee}: 0.001234567 TON`, { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: en.payment.cancel, exact: true })
    .click();
  await f.result("cancelled", 1);
  expect(f.counts()).toEqual({ preparations: 1, claims: 0, cancellations: 1 });
  expect(await f.sends()).toBe(0);
  expect(f.errors).toEqual([]);
});

test("one confirmation sends once, remains unknown, and paid requires API confirmation", async ({
  page,
}) => {
  const f = await fixture(page);
  await f.request();
  await page
    .getByRole("button", { name: en.payment.confirm, exact: true })
    .click();
  await f.result("unknown", 1);
  expect(await f.sends()).toBe(1);
  expect(f.counts().claims).toBe(1);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(
          localStorage.getItem("fixture-ton-transaction") ?? "null",
        ) as unknown,
    ),
  ).toMatchObject({
    network: "-239",
    from: sender,
    messages: [
      {
        address: recipient,
        amount: "1000000001",
        payload: "synthetic-comment",
      },
    ],
  });
  await f.request();
  await f.result("unknown", 2);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(f.counts()).toEqual({ preparations: 2, claims: 1, cancellations: 0 });
  expect(await f.sends()).toBe(1);
  await f.frame.locator("#status").click();
  await f.result("unknown", 3);
  f.paid();
  await f.frame.locator("#status").click();
  await f.result("paid", 4);
  expect(await f.sends()).toBe(1);
  expect(f.errors).toEqual([]);
});

test("disposing the requesting app closes confirmation without sending", async ({
  page,
}) => {
  const f = await fixture(page);
  await f.request();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { fixturePaymentDispose(): void }
    ).fixturePaymentDispose();
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(f.counts()).toEqual({ preparations: 1, claims: 0, cancellations: 0 });
  expect(await f.sends()).toBe(0);
  expect(f.errors).toEqual([]);
});

test("changing wallet before confirmation denies the request without a claim", async ({
  page,
}) => {
  const f = await fixture(page);
  await f.request();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem("fixture-ton-account", `0:${"3".repeat(64)}`);
  });
  await page
    .getByRole("button", { name: en.payment.confirm, exact: true })
    .click();
  await expect(f.frame.locator("body")).toHaveAttribute(
    "data-result",
    "request_failed",
  );
  expect(f.counts().claims).toBe(0);
  expect(await f.sends()).toBe(0);
  expect(f.errors).toEqual([]);
});

test("native Back is consumed while payment confirmation is open", async ({
  page,
}) => {
  const f = await fixture(page);
  await f.request();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { fixturePaymentBack(): void }).fixturePaymentBack();
  });
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(1);
  expect(await f.sends()).toBe(0);
  await page
    .getByRole("button", { name: en.payment.cancel, exact: true })
    .click();
  await f.result("cancelled", 1);
  expect(f.errors).toEqual([]);
});
