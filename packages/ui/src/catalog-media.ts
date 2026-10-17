// Development and test pages only: part of the component catalog (catalog.ts).
import {
  Tally,
  EvidenceLink,
  Actions,
  Badge,
  Countdown,
  Facts,
  Field,
  FilePicker,
  Picture,
  Section,
} from "./index.ts";
import { t, type MessageKey } from "../../i18n/src/index.ts";

const text = (key: string) => t("en", `catalog.${key}` as MessageKey);
/** Fixed artwork with a transparent margin, so the surface behind it shows. */
const ARTWORK = `data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'><circle cx='48' cy='52' r='30' fill='#3a9d5d'/><circle cx='36' cy='34' r='9' fill='#f4f1de'/><circle cx='60' cy='34' r='9' fill='#f4f1de'/></svg>",
)}`;
const noop = () => undefined;

/** Pictures, file picking, labelled values, badges, a frozen timer and a field hint. */
export function mediaSection(): Node {
  // A fixed clock keeps the screenshot stable: 1 h 2 min 3 s left.
  const timer = Countdown({
    until: 3_723_000,
    now: () => 0,
    label: text("timerLabel"),
    format: (remaining) => {
      const seconds = Math.round(remaining / 1000);
      const pad = (value: number) => String(value).padStart(2, "0");
      return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
    },
  });
  timer.dispose();
  const hinted = Field({
    label: text("fieldHintLabel"),
    value: text("fieldHintValue"),
    hint: text("fieldHint"),
  });
  return Section({
    title: text("media"),
    children: [
      Actions([
        Picture({
          src: ARTWORK,
          alt: text("pictureAlt"),
          fallback: text("pictureMissing"),
          size: "thumb",
        }),
      ]),
      Picture({
        src: ARTWORK,
        alt: text("pictureAlt"),
        fallback: text("pictureMissing"),
      }),
      FilePicker({
        label: text("filePicker"),
        accept: "image/png",
        onSelect: noop,
      }).element,
      Facts([
        { label: text("factTop"), value: text("factTopValue") },
        { label: text("factTime"), value: timer.element },
      ]),
      Actions([
        Badge(text("badge")),
        Badge(text("badgeStrong"), { tone: "strong" }),
      ]),
      hinted.element,
      Tally({
        label: t("en", "governance.tally"),
        items: [
          { label: t("en", "governance.choice.for"), count: 12 },
          { label: t("en", "governance.choice.against"), count: 3 },
          { label: t("en", "governance.choice.abstain"), count: 2 },
        ],
      }),
      Tally({
        label: t("en", "governance.tally"),
        items: [{ label: t("en", "governance.choice.for"), count: 0 }],
      }),
      EvidenceLink({
        label: t("en", "governance.link"),
        href: "https://example.com/evidence",
      }),
      EvidenceLink({
        label: text("evidenceUnavailable"),
        href: "javascript:alert(1)",
      }),
    ],
  });
}
