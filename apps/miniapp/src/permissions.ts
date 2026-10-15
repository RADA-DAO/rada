import { Button, Sheet } from "../../../packages/ui/src/index.ts";
import type { MessageKey } from "../../../packages/i18n/src/index.ts";
import type { initializePlatform } from "../../../packages/platform-sdk/src/index.ts";

const permissionKeys = {
  "telegram.username.read": "shell.permissions.telegramUsername",
  "wallet.address.read": "shell.permissions.walletAddress",
  "wallet.balances.read": "shell.permissions.walletBalances",
  "jpegpe.collection.read": "shell.permissions.frogCollection",
  "notifications.send": "shell.permissions.notifications",
} as const satisfies Record<string, MessageKey>;
export function permissionLabel(
  capability: string,
  text: (key: MessageKey) => string,
): string {
  return capability in permissionKeys
    ? text(permissionKeys[capability as keyof typeof permissionKeys])
    : "";
}
export async function openAppPermissions({
  text,
  platform,
  onOpen,
  onClose,
}: {
  text: (key: MessageKey) => string;
  platform: ReturnType<typeof initializePlatform>;
  onOpen: (dialog: HTMLDialogElement) => void;
  onClose: (dialog: HTMLDialogElement) => void;
}) {
  function paragraph(key: MessageKey) {
    const node = document.createElement("p");
    node.textContent = text(key);
    return node;
  }
  const title = text("shell.appPermissions");
  const content = document.createElement("div");
  content.append(paragraph("common.loading"));
  const dialog = Sheet({
    title,
    closeLabel: text("common.close"),
    children: [content],
  });
  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      onClose(dialog);
    },
    { once: true },
  );
  onOpen(dialog);
  document.body.append(dialog);
  dialog.showModal();
  platform.setBackVisible(true);
  async function refresh() {
    try {
      const items = await platform.readAppConsents();
      if (!dialog.open) return;
      content.replaceChildren();
      if (!items.length) content.append(paragraph("shell.noAppPermissions"));
      for (const item of items) {
        const label = permissionLabel(item.capability, text);
        if (!label) continue;
        const row = document.createElement("p");
        row.textContent = `${item.app_id}: ${label} `;
        row.append(
          Button(text("shell.revokePermission"), {
            onClick: () => {
              void platform
                .writeAppConsent(item.app_id, item.capability, false)
                .then(refresh)
                .catch(() => {
                  content.replaceChildren(
                    paragraph("shell.unavailableDescription"),
                  );
                });
            },
          }),
        );
        content.append(row);
      }
    } catch {
      if (dialog.open)
        content.replaceChildren(paragraph("shell.unavailableDescription"));
    }
  }
  await refresh();
}
