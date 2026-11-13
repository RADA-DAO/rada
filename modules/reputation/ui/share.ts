import { Button, setButtonLoading } from "../../../packages/ui/src/index.ts";
import type { Summary } from "../contract.ts";
import type { Translator } from "./forms.ts";
type ShareTarget = {
  share?: (data: { text: string }) => Promise<void>;
  clipboard?: { writeText(text: string): Promise<void> };
};
export function shareText(text: Translator, value: Summary) {
  return text("share.text", {
    period: text(`period.${value.period}`),
    points: value.totalPoints,
    pending: value.pendingCount,
  });
}
export async function share(
  text: string,
  target: ShareTarget,
): Promise<"shared" | "copied" | "cancelled"> {
  if (target.share) {
    try {
      await target.share({ text });
      return "shared";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError")
        return "cancelled";
    }
  }
  if (!target.clipboard) throw new Error("share_unavailable");
  await target.clipboard.writeText(text);
  return "copied";
}
export function shareButton(
  text: Translator,
  value: Summary,
  announce: (message: string) => void,
) {
  const button = Button(text("share.action"), {
    variant: "ghost",
    onClick: () => void send(),
  });
  button.dataset.focusKey = "reputation:share";
  async function send() {
    if (button.disabled) return;
    setButtonLoading(button, true);
    try {
      const result = await share(shareText(text, value), navigator);
      if (result !== "cancelled") announce(text(`share.${result}`));
    } catch {
      announce(text("share.error"));
    } finally {
      setButtonLoading(button, false);
    }
  }
  return button;
}
