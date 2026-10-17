import {
  Actions,
  Button,
  Field,
  Group,
  Section,
  Text,
} from "../../../packages/ui/src/index.ts";
import { t, type Locale } from "../../../packages/i18n/src/index.ts";
import type { ModuleApi } from "../../../packages/platform-sdk/src/module-api.ts";
type Preference = {
  category: "splash" | "governance";
  enabled: boolean;
  quiet_start: number | null;
  quiet_end: number | null;
};
export function notificationSettings(
  api: ModuleApi,
  locale: Locale,
): HTMLElement {
  const status = Text(t(locale, "notifications.loading"), { live: "polite" });
  const content = Group();
  const root = Section({
    title: t(locale, "notifications.title"),
    children: [status, content],
  });
  const render = (preferences: Preference[]) => {
    content.replaceChildren();
    for (const p of preferences) {
      let enabled = p.enabled;
      const toggle = Button(
        t(locale, enabled ? "notifications.on" : "notifications.off"),
        {
          onClick: () => {
            enabled = !enabled;
            toggle.setAttribute("aria-checked", String(enabled));
            toggle.textContent = t(
              locale,
              enabled ? "notifications.on" : "notifications.off",
            );
          },
        },
      );
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", String(enabled));
      toggle.setAttribute(
        "aria-label",
        t(locale, `notifications.${p.category}`),
      );
      const quiet = Field({
        label: t(locale, "notifications.quiet"),
        kind: "select",
        value: p.quiet_start === null ? "none" : "night",
        choices: [
          { value: "none", label: t(locale, "notifications.none") },
          { value: "night", label: t(locale, "notifications.night") },
        ],
      });
      const save = Button(t(locale, "notifications.save"), {
        onClick: () => void run("preferences"),
      });
      const test = Button(t(locale, "notifications.test"), {
        disabled: !p.enabled,
        onClick: () => void run("test"),
      });
      const run = async (action: "preferences" | "test") => {
        save.disabled = true;
        test.disabled = true;
        toggle.disabled = true;
        quiet.control.disabled = true;
        try {
          const response = await api.request(
            "POST",
            `/v1/notifications/${action}`,
            {
              body: {
                json:
                  action === "test"
                    ? { category: p.category }
                    : {
                        category: p.category,
                        enabled,
                        locale,
                        quiet_start:
                          quiet.control.value === "night" ? 22 : null,
                        quiet_end: quiet.control.value === "night" ? 8 : null,
                      },
              },
            },
          );
          if (response.status >= 300)
            throw new Error("notification_request_failed");
          status.textContent = t(
            locale,
            action === "test" ? "notifications.queued" : "notifications.saved",
          );
          if (action === "preferences") p.enabled = enabled;
        } catch {
          status.textContent = t(locale, "notifications.error");
        } finally {
          save.disabled = false;
          test.disabled = !p.enabled;
          toggle.disabled = false;
          quiet.control.disabled = false;
        }
      };
      content.append(
        Section({
          title: t(locale, `notifications.${p.category}`),
          children: [
            Text(t(locale, "notifications.consent")),
            toggle,
            quiet.element,
            Actions([save, test]),
          ],
        }),
      );
    }
  };
  void api
    .request("GET", "/v1/notifications/preferences")
    .then((response) => {
      if (response.status !== 200)
        throw new Error("notification_request_failed");
      render((response.body as { preferences: Preference[] }).preferences);
      status.textContent = "";
    })
    .catch(() => {
      status.textContent = t(locale, "notifications.error");
    });
  return root;
}
