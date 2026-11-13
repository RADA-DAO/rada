import {
  Actions,
  Button,
  Field,
  Text,
  openSheet,
  setButtonLoading,
} from "../../../packages/ui/src/index.ts";
import type { Navigation } from "../../../packages/platform-sdk/src/index.ts";
import type { AppealInput, ReportInput } from "../contract.ts";
import { ReputationError } from "./model.ts";
export type Translator = (
  key: string,
  values?: Record<string, string | number>,
) => string;
export type Draft<T> = { body?: T; attempted: boolean; requestId?: string };
export type FormContext = {
  text: Translator;
  navigation: Navigation;
  signal: AbortSignal;
  error(error: unknown): string;
  notice(message: string): void;
};
/** Inputs freeze once sent: an uncertain retry must preserve both ID and payload. */
export function reportForm(
  ctx: FormContext,
  opener: HTMLElement,
  draft: Draft<ReportInput>,
  send: (body: ReportInput, recover: boolean) => Promise<void>,
) {
  const text = ctx.text;
  const title = Field({
    label: text("report.title"),
    required: true,
    maxLength: 200,
    value: draft.body?.title ?? "",
  });
  const description = Field({
    label: text("report.description"),
    kind: "textarea",
    required: true,
    rows: 5,
    maxLength: 4000,
    value: draft.body?.description ?? "",
  });
  const occurred = Field({ label: text("report.occurredAt"), required: true });
  (occurred.control as HTMLInputElement).type = "datetime-local";
  const date = new Date(draft.body?.occurredAt ?? Date.now());
  occurred.control.value = new Date(
    date.getTime() - date.getTimezoneOffset() * 60000,
  )
    .toISOString()
    .slice(0, 16);
  const evidence = Field({
    label: text("report.evidence"),
    hint: text("report.optional"),
    value: draft.body?.evidenceUrl ?? "",
    maxLength: 2000,
  });
  const fields = [title, description, occurred, evidence];
  show(
    ctx,
    opener,
    text("report.open"),
    [Text(text("report.hint")), ...fields.map((field) => field.element)],
    fields.map((field) => field.control),
    draft,
    async () => {
      if (!draft.body) {
        let valid = true;
        for (const field of [title, description, occurred]) {
          const invalid = !field.control.value.trim();
          field.setError(invalid ? text("required") : undefined);
          if (invalid) valid = false;
        }
        const instant = new Date(occurred.control.value);
        if (
          !Number.isFinite(instant.getTime()) ||
          instant.getTime() > Date.now()
        ) {
          occurred.setError(text("report.invalidDate"));
          valid = false;
        }
        const url = evidence.control.value.trim();
        if (url) {
          try {
            const parsed = new URL(url);
            if (
              parsed.protocol !== "https:" ||
              parsed.username ||
              parsed.password
            )
              throw new Error();
          } catch {
            evidence.setError(text("report.invalidUrl"));
            valid = false;
          }
        }
        if (!valid) return false;
        draft.body = {
          requestId: draft.requestId ?? crypto.randomUUID(),
          title: title.control.value.trim(),
          description: description.control.value.trim(),
          occurredAt: instant.toISOString(),
          ...(url ? { evidenceUrl: url } : {}),
        };
      }
      await send(draft.body, draft.attempted);
      return true;
    },
  );
}
export function appealForm(
  ctx: FormContext,
  opener: HTMLElement,
  draft: Draft<AppealInput>,
  send: (body: AppealInput) => Promise<void>,
) {
  const message = Field({
    label: ctx.text("appeal.message"),
    kind: "textarea",
    required: true,
    rows: 5,
    maxLength: 4000,
    value: draft.body?.message ?? "",
  });
  show(
    ctx,
    opener,
    ctx.text("appeal.open"),
    [Text(ctx.text("appeal.hint")), message.element],
    [message.control],
    draft,
    async () => {
      if (!draft.body) {
        if (!message.control.value.trim()) {
          message.setError(ctx.text("required"));
          return false;
        }
        draft.body = {
          requestId: draft.requestId ?? crypto.randomUUID(),
          message: message.control.value.trim(),
        };
      }
      await send(draft.body);
      return true;
    },
  );
}
function show<T>(
  ctx: FormContext,
  opener: HTMLElement,
  title: string,
  children: Node[],
  controls: (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[],
  draft: Draft<T>,
  submit: () => Promise<boolean>,
) {
  let busy = false;
  const message = Text(draft.attempted ? ctx.text("uncertain") : "", {
    live: "polite",
  });
  const save = Button(ctx.text(draft.attempted ? "retry" : "submit"), {
    variant: "primary",
    onClick: () => void send(),
  });
  const freeze = () => {
    controls.forEach((control) => {
      control.disabled = draft.attempted;
    });
  };
  freeze();
  const sheet = openSheet({
    title,
    closeLabel: ctx.text("close"),
    navigation: ctx.navigation,
    opener,
    children: [...children, message, Actions([save])],
  });
  const close = () => {
    sheet.close();
  };
  ctx.signal.addEventListener("abort", close, { once: true });
  sheet.addEventListener(
    "close",
    () => {
      ctx.signal.removeEventListener("abort", close);
    },
    { once: true },
  );
  const live = () => !ctx.signal.aborted;
  async function send() {
    if (busy || ctx.signal.aborted) return;
    busy = true;
    setButtonLoading(save, true);
    try {
      const result = submit();
      if (draft.body) {
        draft.attempted = true;
        freeze();
      }
      if ((await result) && live()) sheet.close();
    } catch (error) {
      if (!live() || !sheet.open) return;
      const definitive =
        error instanceof ReputationError &&
        [400, 403, 409, 422].includes(error.status);
      if (definitive) {
        delete draft.body;
        draft.attempted = false;
        freeze();
      }
      message.textContent = definitive
        ? ctx.error(error)
        : ctx.text("uncertain");
      save.textContent = ctx.text("retry");
    } finally {
      busy = false;
      setButtonLoading(save, false);
    }
  }
}
