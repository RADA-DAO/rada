import "@rada/ui/screens/profile.css";
import { mountProfile } from "./profile.ts";
import { mountWallet } from "./wallet.ts";
import { Button, Group } from "../../../packages/ui/src/index.ts";
import { profileActionIcon } from "../../../packages/ui/src/frog-card.ts";
import { t } from "../../../packages/i18n/src/index.ts";
import type { initializePlatform } from "../../../packages/platform-sdk/src/index.ts";

type ProfileOptions = Parameters<typeof mountProfile>[1];
export function mountProfilePanel(
  content: HTMLElement,
  options: Pick<
    ProfileOptions,
    "locale" | "selected" | "refresh" | "openCollection"
  > & {
    platform: ReturnType<typeof initializePlatform>;
  },
): () => void {
  const { platform, ...profile } = options;
  const collection = content.querySelector<HTMLElement>(
    "[data-profile-collection]",
  );
  const wallet = content.querySelector<HTMLElement>("[data-profile-wallet]");
  if (!collection || !wallet) return () => {};
  content.classList.add("rada-profile-view");
  const stopCollection = mountProfile(collection, {
    ...profile,
    artwork: (path, signal) => platform.readFrogArtwork(path, signal),
    select: (frogId, signal) => platform.selectProfileFrog(frogId, signal),
  });
  const actions = collection.querySelector<HTMLElement>(
    ".rada-profile-actions",
  );
  const details = collection.querySelector<HTMLElement>(
    "[data-profile-details]",
  );
  const body = collection.parentElement;
  const settings = content.querySelector<HTMLButtonElement>(
    ".rada-screen-header button",
  );
  const menu = Group();
  menu.classList.add("rada-profile-menu");
  menu.id = "profile-details";
  menu.hidden = true;
  if (details) menu.append(details);
  const text = (key: Parameters<typeof t>[1]) => t(profile.locale, key);
  const summary = Group();
  summary.classList.add("rada-profile-summary");
  // The shell owns authorization; only relocate entries it already rendered.
  for (const child of Array.from(body?.children ?? [])) {
    if (child === collection || child === wallet || child.tagName === "H1")
      continue;
    if (child.classList.contains("rada-text")) {
      if (child.textContent === text("shell.private")) {
        child.remove();
        continue;
      }
      const chip = Group([child]);
      chip.classList.add("rada-profile-status");
      if (child.textContent === text("shell.membership.unavailable"))
        chip.append(
          Button(text("profile.retryMembership"), {
            onClick: profile.refresh,
          }),
        );
      summary.append(chip);
    } else if (
      child.tagName === "BUTTON" &&
      child.textContent === text("shell.appPermissions")
    ) {
      menu.append(child);
    } else {
      child.classList.add(
        child.classList.contains("rada-error-state")
          ? "rada-profile-inline-error"
          : "rada-profile-entry",
      );
      summary.append(child);
    }
  }
  collection.after(summary);
  const more = profileActionIcon(
    Button(t(profile.locale, "profile.details"), {
      onClick: () => {
        menu.hidden = !menu.hidden;
        more.setAttribute("aria-expanded", String(!menu.hidden));
      },
    }),
    "profile",
  );
  more.dataset.profileMore = "true";
  more.setAttribute("aria-expanded", "false");
  more.setAttribute("aria-controls", menu.id);
  if (settings) actions?.prepend(profileActionIcon(settings, "notifications"));
  const stopWallet = mountWallet(
    wallet,
    profile.locale,
    platform,
    actions ?? undefined,
  );
  actions?.append(more);
  body?.append(menu);
  return () => {
    stopCollection();
    stopWallet();
  };
}
