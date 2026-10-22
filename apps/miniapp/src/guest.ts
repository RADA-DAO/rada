import { Button, Field, Screen } from "../../../packages/ui/src/index.ts";
import { t, type Locale } from "../../../packages/i18n/src/index.ts";
import "@rada/ui/screens/guest.css";

/** A configured Telegram Mini App URL; never fall back to a different product. */
export function telegramEntry(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol === "https:" &&
      url.hostname === "t.me" &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^\/[a-zA-Z0-9_]+(?:\/[a-zA-Z0-9_]+)?\/?$/.test(url.pathname)
    )
      return url.href;
  } catch {
    // An absent or invalid deployment setting has no actionable destination.
  }
}

export function guestEntry(locale: Locale): HTMLElement {
  const text = (key: Parameters<typeof t>[1]) => t(locale, key);
  const entry = telegramEntry(import.meta.env.VITE_TELEGRAM_APP_LINK);
  const orb = document.createElement("div");
  orb.className = "guest-orb";
  orb.append(document.createTextNode(String.fromCodePoint(0x2301)));
  orb.setAttribute("aria-hidden", "true");
  const description = document.createElement("p");
  description.textContent = text("home.guestDescription");
  const status = document.createElement("span");
  status.className = "guest-copy-status";
  status.setAttribute("role", "status");
  const children: Node[] = [description];
  if (entry) {
    const link = document.createElement("a");
    link.className = "guest-telegram";
    link.href = entry;
    link.textContent = text("home.guestOpen");
    const field = Field({ label: text("home.guestLink"), value: entry });
    (field.control as HTMLInputElement).readOnly = true;
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = text("home.guestOtherDevice");
    details.append(summary, field.element);
    const copy = Button(text("home.guestCopy"), {
      variant: "ghost",
      onClick: () => {
        const clipboard = (navigator as Partial<Navigator>).clipboard;
        if (!clipboard) {
          revealLink();
          return;
        }
        void clipboard.writeText(entry).then(
          () => {
            status.textContent = text("home.guestCopied");
          },
          () => {
            revealLink();
          },
        );
      },
    });
    function revealLink() {
      details.open = true;
      status.textContent = text("home.guestCopyFallback");
      field.control.focus();
      (field.control as HTMLInputElement).select();
    }
    copy.classList.add("guest-copy");
    children.push(link, copy, status, details);
  } else {
    status.textContent = text("home.guestUnavailable");
    children.push(status);
  }
  const view = Screen({ title: text("shell.brand"), top: orb, children });
  view.className = "guest-entry";
  return view;
}

export function mountGuest(host: HTMLElement, locale: Locale) {
  host.dataset.workspace = "false";
  host.dataset.home = "false";
  host.dataset.guest = "true";
  host.replaceChildren(guestEntry(locale));
}
