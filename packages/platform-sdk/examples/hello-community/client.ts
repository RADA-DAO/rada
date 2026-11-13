// Build-time values are inlined into the single immutable HTML artifact.
declare const translations: Record<"en" | "uk", Record<string, string>>;
declare const revision: number;
declare const installAppKeyboard: (options: {
  doneLabel(): string;
  dismissLabel(): string;
  hostHeight(): number;
}) => { refresh(): void; dispose(): void };
type CommunityContext = {
  locale?: string;
  ui?: { viewport: { visibleHeight: number } };
};
type MemberBridge = {
  subscribeContext(listener: (value: CommunityContext) => void): () => void;
  openDialog(dialog: HTMLDialogElement, opener?: HTMLElement): Promise<boolean>;
  request(type: string): Promise<unknown>;
  back(): void;
};

async function startExample() {
  const member = (window as unknown as { rada?: { member: MemberBridge } }).rada
    ?.member;
  let context: CommunityContext = {};
  let locale: "en" | "uk" = "en";
  if (member) {
    context = (await member.request(
      "rada.member.context.get",
    )) as CommunityContext;
    if (context.locale === "uk") locale = "uk";
  }
  const copy = translations[locale];
  const t = (key: string, value = "") =>
    (copy[key] ?? key).replace(/\{(?:count|revision)\}/g, value);
  const keyboard = installAppKeyboard({
    doneLabel: () => t("done"),
    dismissLabel: () => t("dismiss"),
    hostHeight: () => context.ui?.viewport.visibleHeight ?? window.innerHeight,
  });
  const unsubscribe = member?.subscribeContext((value) => {
    context = value;
    keyboard.refresh();
  });
  addEventListener("pagehide", (event) => {
    if (event.persisted) return;
    unsubscribe?.();
    keyboard.dispose();
  });
  document.documentElement.lang = locale;
  document.querySelectorAll<HTMLElement>("[data-copy]").forEach((element) => {
    element.textContent = t(element.dataset.copy ?? "");
  });
  const release = document.querySelector<HTMLElement>("#release");
  if (release) release.textContent = t("revision", String(revision));
  const count = document.querySelector<HTMLElement>("#count");
  let value = 0;
  const render = () => {
    if (count) count.textContent = t("count", String(value));
  };
  document.querySelector("#increment")?.addEventListener("click", () => {
    value++;
    render();
  });
  document.querySelector("#back")?.addEventListener("click", () => {
    member?.back();
  });
  const details = document.querySelector<HTMLDialogElement>("#details");
  const detailsButton = document.querySelector<HTMLElement>("#open-details");
  detailsButton?.addEventListener("click", () => {
    if (details && member) void member.openDialog(details, detailsButton);
  });
  document.querySelector("#close-details")?.addEventListener("click", () => {
    details?.close();
  });
  render();
  document.body.dataset.ready = "true";
  document.body.dataset.revision = String(revision);
  if (!member && count) count.textContent = t("unavailable");
}

void startExample();
