import {
  Avatar,
  Button,
  List,
  ListItem,
  LiveRegion,
  Loading,
  openSheet,
  setButtonLoading,
  Text,
  type SheetNavigation,
} from "../../../packages/ui/src/index.ts";
import {
  t,
  type Locale,
  type MessageKey,
} from "../../../packages/i18n/src/index.ts";
import type { initializePlatform } from "../../../packages/platform-sdk/src/index.ts";

const permissionKeys = {
  "storage.self": "shell.permissions.storage",
  scores: "shell.permissions.scores",
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
export function consentCopy(
  locale: Locale,
  permission: string,
  appName: string,
) {
  const text = (key: MessageKey) => t(locale, key);
  return {
    title: text("shell.consentTitle"),
    description: t(locale, "shell.consentDescription", {
      app: appName,
      permission: permissionLabel(permission, text),
    }),
    allow: text("shell.consentAllow"),
    deny: text("shell.consentDeny"),
  };
}
export async function openAppPermissions({
  text,
  platform,
  navigation,
  opener,
}: {
  text: (key: MessageKey, values?: Record<string, string>) => string;
  platform: ReturnType<typeof initializePlatform>;
  navigation: SheetNavigation;
  opener: HTMLElement | null;
}) {
  const content = LiveRegion([Loading({ message: text("common.loading") })]);
  const dialog = openSheet({
    title: text("shell.appPermissions"),
    closeLabel: text("common.close"),
    children: [content],
    navigation,
    opener,
  });
  const unavailable = () => {
    content.replaceChildren(Text(text("shell.unavailableDescription")));
  };
  async function refresh() {
    try {
      const items = await platform.readAppConsents();
      if (!dialog.open) return;
      content.replaceChildren();
      if (!items.length) content.append(Text(text("shell.noAppPermissions")));
      const rows = items.flatMap((item) => {
        const label = permissionLabel(item.capability, text);
        if (!label) return [];
        const revoke = Button(text("shell.revokePermission"), {
          ariaLabel: text("shell.revokePermissionFor", {
            app: item.app_id,
            permission: label,
          }),
          onClick: () => {
            setButtonLoading(revoke, true);
            void platform
              .writeAppConsent(item.app_id, item.capability, false)
              .then(refresh)
              .catch(unavailable);
          },
        });
        return [
          ListItem({
            leading: Avatar({ name: item.app_id, size: "small" }),
            title: item.app_id,
            description: label,
            actions: [revoke],
          }),
        ];
      });
      if (rows.length) content.append(List({ children: rows }));
    } catch {
      if (dialog.open) unavailable();
    }
  }
  await refresh();
}
