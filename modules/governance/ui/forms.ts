import {
  Actions,
  Button,
  Field,
  openSheet,
  Text,
  setButtonLoading,
} from "../../../packages/ui/src/index.ts";
import type { FieldOptions } from "../../../packages/ui/src/index.ts";
import { errorText, type Context } from "./context.ts";

/** Every mutation is single-flight and remains in its sheet on validation/error. */
export function form(
  ctx: Context,
  options: {
    title: string;
    path: string;
    fields: (FieldOptions & { key: string })[];
    payload?(values: Record<string, string>): unknown;
    validate?(values: Record<string, string>): boolean;
    opener?: HTMLElement;
  },
) {
  const fields = options.fields.map(({ key, ...props }) => ({
    key,
    field: Field(props),
  }));
  const message = Text("", { live: "polite" });
  let busy = false;
  const save = Button(ctx.text("submit"), {
    variant: "primary",
    onClick: () => void submit(),
  });
  const sheet = openSheet({
    title: options.title,
    closeLabel: ctx.text("close"),
    navigation: ctx.navigation,
    ...(options.opener ? { opener: options.opener } : {}),
    children: [
      ...fields.map(({ field }) => field.element),
      message,
      Actions([save]),
    ],
  });
  const abort = () => {
    sheet.close();
  };
  ctx.signal.addEventListener("abort", abort, { once: true });
  sheet.addEventListener(
    "close",
    () => {
      ctx.signal.removeEventListener("abort", abort);
    },
    { once: true },
  );
  async function submit() {
    if (busy) return;
    const values: Record<string, string> = {};
    let valid = true;
    for (const { key, field } of fields) {
      const value = field.control.value.replace(/\r?\n/g, " ").trim();
      values[key] = value;
      const invalid =
        (field.control.required && !value) || /\p{Cc}/u.test(value);
      field.setError(invalid ? ctx.text("required") : undefined);
      if (invalid) valid = false;
    }
    if (!valid || options.validate?.(values) === false) {
      message.textContent = ctx.text("invalid");
      return;
    }
    busy = true;
    setButtonLoading(save, true);
    try {
      await ctx.client.write(
        options.path,
        options.payload ? options.payload(values) : values,
      );
      if (ctx.signal.aborted) return;
      sheet.close();
      await ctx.refresh();
    } catch (error) {
      if (!ctx.signal.aborted && sheet.open)
        message.textContent = errorText(ctx, error);
    } finally {
      busy = false;
      setButtonLoading(save, false);
    }
  }
}
export function createProposal(ctx: Context, opener: HTMLElement) {
  form(ctx, {
    title: ctx.text("create"),
    path: "/proposals",
    opener,
    fields: [
      {
        key: "title",
        label: ctx.text("proposalTitle"),
        required: true,
        maxLength: 200,
      },
      {
        key: "body",
        label: ctx.text("body"),
        required: true,
        kind: "textarea",
        rows: 7,
        maxLength: 20000,
      },
    ],
  });
}
export function decide(ctx: Context, id: string, opener: HTMLElement) {
  form(ctx, {
    title: ctx.text("decide"),
    path: `/proposals/${id}/decide`,
    opener,
    fields: [
      {
        key: "outcome",
        label: ctx.text("outcome"),
        kind: "select",
        value: "defer",
        choices: ["accept", "reject", "defer"].map((value) => ({
          value,
          label: ctx.text(`status.${value}`),
        })),
      },
      {
        key: "reason",
        label: ctx.text("reason"),
        required: true,
        kind: "textarea",
        maxLength: 4000,
      },
    ],
  });
}
export function attachEvidence(ctx: Context, id: string, opener: HTMLElement) {
  form(ctx, {
    title: ctx.text("attachEvidence"),
    path: `/proposals/${id}/evidence`,
    opener,
    fields: [
      {
        key: "body",
        label: ctx.text("evidenceBody"),
        required: true,
        kind: "textarea",
        maxLength: 4000,
      },
      { key: "link", label: ctx.text("link"), maxLength: 2048 },
      { key: "tx_hash", label: ctx.text("tx"), maxLength: 64 },
    ],
    payload: (values) =>
      Object.fromEntries(Object.entries(values).filter(([, value]) => value)),
    validate: (values) => {
      if (values.tx_hash && !/^[a-f0-9]{64}$/i.test(values.tx_hash))
        return false;
      if (!values.link) return true;
      try {
        const url = new URL(values.link);
        return url.protocol === "https:" && !url.username && !url.password;
      } catch {
        return false;
      }
    },
  });
}
