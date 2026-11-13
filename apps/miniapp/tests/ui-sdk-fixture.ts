import { expect, type Page, type TestInfo } from "@playwright/test";
import { compileTheme } from "../../../packages/ui/src/theme-compiler.ts";
import {
  runExampleLifecycle,
  syntheticLaunch,
} from "../../../packages/platform-sdk/scripts/example-lifecycle.ts";

export type UiContext = {
  locale: string;
  ui: {
    version: number;
    tokens: Record<string, string>;
    viewport: {
      width: number;
      height: number;
      visibleHeight: number;
      keyboardInset: number;
    };
    safeArea: { top: number; right: number; bottom: number; left: number };
    reducedMotion: boolean;
    rootFontSize: number;
  };
};
type LocalHost = {
  emit(name: string, values?: Record<string, unknown>): void;
  back(): void;
  listeners(): number;
};

export async function emitHost(
  page: Page,
  event: string,
  values: Record<string, unknown> = {},
) {
  await page.evaluate(
    ({ event, values }) => {
      (window as unknown as { radaLocalHost: LocalHost }).radaLocalHost.emit(
        event,
        values,
      );
    },
    { event, values },
  );
}

export async function nativeBack(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { radaLocalHost: LocalHost }).radaLocalHost.back();
  });
}

export async function applyPalette(
  page: Page,
  background: string,
  accent: string | null,
) {
  const palette = compileTheme(background, accent);
  await page.evaluate((palette) => {
    for (const [name, value] of Object.entries(palette.tokens))
      document.documentElement.style.setProperty(name, value);
  }, palette);
  return palette;
}

export const child = (page: Page) =>
  page.frameLocator("iframe[sandbox='allow-scripts']");

export async function readUiContext(page: Page): Promise<UiContext> {
  return child(page)
    .locator("body")
    .evaluate(
      (body) => JSON.parse(body.dataset.uiTestContext ?? "null") as UiContext,
    );
}

export async function openExample(page: Page) {
  await page.getByRole("button", { name: /^Hello community/ }).click();
  await expect(child(page).locator("body")).toHaveAttribute(
    "data-ready",
    "true",
  );
  // Observe pushes, rather than polling the bridge and consuming its rate budget.
  await child(page)
    .locator("body")
    .evaluate(async (body) => {
      const bridge = (
        window as unknown as {
          rada: {
            member: {
              request(type: string): Promise<unknown>;
              subscribeContext(handler: (context: unknown) => void): () => void;
            };
          };
        }
      ).rada.member;
      body.dataset.uiTestContext = JSON.stringify(
        await bridge.request("rada.member.context.get"),
      );
      bridge.subscribeContext((context) => {
        body.dataset.uiTestContext = JSON.stringify(context);
      });
    });
}

/** Real registry and immutable artifacts; only this test's app is withdrawn. */
export async function withExample(
  page: Page,
  info: TestInfo,
  run: () => Promise<void>,
) {
  const apiOrigin = process.env.RADA_LOCAL_API_ORIGIN;
  const artifactsDirectory = process.env.RADA_LOCAL_ARTIFACT_DIR;
  if (!apiOrigin || !artifactsDirectory)
    throw new Error("Disposable local platform required");
  const appId = `example.hello.ui-${info.project.name}-${String(Date.now())}`;
  const pageErrors: string[] = [];
  const onError = (error: Error) => {
    pageErrors.push(error.message);
  };
  page.on("pageerror", onError);
  try {
    await runExampleLifecycle({
      apiOrigin,
      artifactsDirectory,
      appId,
      seedOnly: true,
    });
    const catalog = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/apps/published"),
    );
    await page.goto("/");
    expect((await catalog).status()).toBe(200);
    await openExample(page);
    await run();
    expect(pageErrors).toEqual([]);
  } finally {
    page.off("pageerror", onError);
    const response = await fetch(`${apiOrigin}/apps/${appId}/withdraw`, {
      method: "POST",
      headers: {
        Authorization: `tma ${syntheticLaunch(102)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "UI/SDK fixture complete" }),
      signal: AbortSignal.timeout(10_000),
    });
    expect([200, 409]).toContain(response.status);
  }
}
