// Build-time values are inlined into the single immutable HTML artifact.
declare const translations: Record<"en" | "uk", Record<string, string>>;
declare const revision: number;
type MemberBridge = {
  request(type: string): Promise<unknown>;
  back(): void;
};

async function startExample() {
  const member = (window as unknown as { rada?: { member: MemberBridge } }).rada
    ?.member;
  let locale: "en" | "uk" = "en";
  if (member) {
    const context = (await member.request("rada.member.context.get")) as {
      locale?: string;
    };
    if (context.locale === "uk") locale = "uk";
  }
  const copy = translations[locale];
  const t = (key: string, value = "") =>
    (copy[key] ?? key).replace(/\{(?:count|revision)\}/g, value);
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
  render();
  document.body.dataset.ready = "true";
  document.body.dataset.revision = String(revision);
  if (!member && count) count.textContent = t("unavailable");
}

void startExample();
