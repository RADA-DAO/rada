import { test, expect, type Page } from "@playwright/test";

/** Telegram stand-in that records BackButton visibility and can press it. */
async function host(page: Page) {
  await page.addInitScript(() => {
    const listeners = new Map<string, () => void>();
    const log: string[] = [];
    Object.assign(window, {
      Telegram: {
        WebApp: {
          initData: "",
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
            show: () => log.push("show"),
            hide: () => log.push("hide"),
            onClick: (cb: () => void) => listeners.set("back", cb),
            offClick: () => listeners.delete("back"),
          },
        },
      },
      fixtureHost: {
        log,
        back: () => listeners.get("back")?.(),
        resize: (height: number) => {
          (
            window as unknown as {
              Telegram: { WebApp: { viewportHeight: number } };
            }
          ).Telegram.WebApp.viewportHeight = height;
          listeners.get("viewportChanged")?.();
        },
      },
    });
  });
}
type Fixture = { log: string[]; back(): void; resize(height: number): void };
const lastBackState = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { fixtureHost: Fixture }).fixtureHost.log.at(-1) ??
      null,
  );
const pressBack = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { fixtureHost: Fixture }).fixtureHost.back();
  });
const apps = (page: Page) =>
  page.getByRole("heading", { name: "Apps", exact: true });
const profileHeading = (page: Page) =>
  page.getByRole("heading", { name: "Profile", exact: true });
const openProfile = (page: Page) =>
  page.getByRole("button", { name: "Profile", exact: true }).click();

test.beforeEach(async ({ page }) => {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ body: "" }),
  );
  await host(page);
  await page.goto("/");
});

test("Telegram Back shows only above the root and pops one screen", async ({
  page,
}) => {
  await expect(apps(page)).toBeVisible();
  expect(await lastBackState(page)).toBe("hide");
  await openProfile(page);
  await expect(profileHeading(page)).toBeVisible();
  expect(await lastBackState(page)).toBe("show");
  await pressBack(page);
  await expect(apps(page)).toBeVisible();
  expect(await lastBackState(page)).toBe("hide");
});

test("browser Back and Escape follow the same stack", async ({ page }) => {
  await openProfile(page);
  await expect(profileHeading(page)).toBeVisible();
  await page.goBack();
  await expect(apps(page)).toBeVisible();
  await page.goForward();
  await expect(apps(page)).toBeVisible();
  await openProfile(page);
  await page.keyboard.press("Escape");
  await expect(apps(page)).toBeVisible();
  expect(await page.evaluate((): unknown => history.state)).toEqual({
    radaNav: 0,
  });
});

test("Escape closes an open sheet first and then goes back", async ({
  page,
}) => {
  await openProfile(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(profileHeading(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(apps(page)).toBeVisible();
});

/** Real touch in Chromium; WebKit has no touch injection, so it uses the primary pointer. */
async function drag(
  page: Page,
  from: [number, number],
  to: [number, number],
  hold = 0,
) {
  const [x0, y0] = from;
  const [x1, y1] = to;
  const steps = 12;
  const at = (i: number) => ({
    x: x0 + ((x1 - x0) * i) / steps,
    y: y0 + ((y1 - y0) * i) / steps,
  });
  if (test.info().project.name.startsWith("chromium")) {
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", i: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [at(i)],
      });
    await touch("touchStart", 0);
    for (let i = 1; i <= steps; i++) await touch("touchMove", i);
    if (hold) await page.waitForTimeout(hold);
    await touch("touchEnd", steps);
    await cdp.detach();
    return;
  }
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(at(i).x, at(i).y);
  if (hold) await page.waitForTimeout(hold);
  await page.mouse.up();
}

test("edge swipe right goes back, a short drag cancels", async ({
  page,
}, info) => {
  test.skip(!info.project.name.endsWith("mobile"), "touch gesture");
  await openProfile(page);
  const width = page.viewportSize()?.width ?? 390;
  await drag(page, [4, 300], [width * 0.15, 305], 200);
  await expect(profileHeading(page)).toBeVisible();
  await expect(page.locator(".screen-wrap")).not.toHaveClass(/rada-back/);
  await drag(page, [4, 300], [width * 0.9, 305]);
  await expect(apps(page)).toBeVisible();
  expect(await lastBackState(page)).toBe("hide");
});

test("swipe ignores horizontal scrollers and the root screen", async ({
  page,
}, info) => {
  test.skip(!info.project.name.endsWith("mobile"), "touch gesture");
  await drag(page, [4, 300], [350, 305]);
  await expect(apps(page)).toBeVisible();
  await openProfile(page);
  await page.evaluate(() => {
    const strip = document.createElement("div");
    strip.id = "strip";
    strip.style.cssText =
      "overflow-x:auto;height:80px;position:fixed;left:0;top:200px;width:100%";
    strip.innerHTML = '<div style="width:2000px;height:60px"></div>';
    document.querySelector(".screen")?.append(strip);
  });
  await drag(page, [4, 240], [350, 242]);
  await expect(profileHeading(page)).toBeVisible();
});

test("a focused field stays visible above the on-screen keyboard", async ({
  page,
}) => {
  await openProfile(page);
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "600px";
    const field = document.createElement("input");
    field.id = "low-field";
    field.type = "text";
    document.querySelector(".workspace")?.append(spacer, field);
  });
  await page.evaluate(() => {
    (window as unknown as { fixtureHost: Fixture }).fixtureHost.resize(420);
  });
  await page.locator("#low-field").focus();
  await expect
    .poll(async () => {
      const box = await page.locator("#low-field").boundingBox();
      return box ? box.y + box.height <= 420 - 12 && box.y >= 0 : false;
    })
    .toBe(true);
});
