import {
  t,
  type Locale,
  type MessageKey,
} from "../../../packages/i18n/src/index.ts";
import type { ReportCopy } from "../../../packages/platform-sdk/src/app-report.ts";
export function reportCopy(locale: Locale): ReportCopy {
  const text = (key: MessageKey) => t(locale, key);
  return {
    title: text("appReport.title"),
    description: text("appReport.description"),
    category: text("appReport.category"),
    text: text("appReport.text"),
    send: text("appReport.send"),
    cancel: text("common.close"),
    categories: {
      bug: text("appReport.bug"),
      content: text("appReport.content"),
      privacy: text("appReport.privacy"),
      other: text("appReport.otherCategory"),
    },
  };
}
