import {
  Button,
  EmptyState,
  ErrorState,
} from "../../../packages/ui/src/index.ts";
import {
  t,
  type Locale,
  type MessageKey,
} from "../../../packages/i18n/src/index.ts";
import type { ReviewVersion } from "../../../packages/platform-sdk/src/index.ts";

export function mountReview(
  container: HTMLElement,
  options: {
    locale: Locale;
    read(signal: AbortSignal): Promise<ReviewVersion[]>;
    decide(
      appId: string,
      versionId: string,
      decision: "approve" | "reject",
      reason: string,
      signal: AbortSignal,
    ): Promise<void>;
    closePreview(): void;
  },
) {
  const lifecycle = new AbortController();
  const text = (key: MessageKey) => t(options.locale, key);
  let generation = 0;
  let busy = false;
  let previewDispose: (() => void) | undefined;
  const closePreview = () => {
    previewDispose?.();
    previewDispose = undefined;
    options.closePreview();
  };
  const para = (key: MessageKey) => {
    const p = document.createElement("p");
    p.textContent = text(key);
    return p;
  };
  const current = (id: number) =>
    !lifecycle.signal.aborted && generation === id;
  const errorState = (error: unknown) => {
    const code = error instanceof Error ? error.message : "unavailable";
    closePreview();
    container.replaceChildren(
      ErrorState({
        message: text(
          code === "forbidden"
            ? "review.denied"
            : code === "expired"
              ? "shell.expiredDescription"
              : code === "stale"
                ? "review.stale"
                : "shell.unavailableDescription",
        ),
        retryLabel: text("common.retry"),
        onRetry: () => void load(),
      }),
    );
  };
  async function load() {
    const id = ++generation;
    closePreview();
    container.replaceChildren(para("common.loading"));
    try {
      const versions = await options.read(lifecycle.signal);
      if (!current(id)) return;
      container.replaceChildren();
      if (!versions.length)
        container.append(
          EmptyState({
            title: text("review.empty"),
            message: text("review.emptyDescription"),
          }),
        );
      for (const version of versions) {
        const row = document.createElement("article");
        row.className = "review-row";
        const heading = document.createElement("h2");
        heading.textContent = version.manifest.name;
        const meta = document.createElement("p");
        meta.textContent = `${version.appId} · ${version.versionNo} · ${version.manifest.author}`;
        const requested = document.createElement("ul");
        for (const permission of version.manifest.permissions) {
          const li = document.createElement("li");
          li.textContent = text(`review.permissions.${permission}`);
          requested.append(li);
        }
        const declarations = document.createElement("p");
        declarations.textContent = t(options.locale, "review.declarations", {
          trust: text(
            version.manifest.trustLevel === "official"
              ? "review.officialRequested"
              : "review.communityRequested",
          ),
          design: text(
            version.manifest.designRoute === "standard"
              ? "review.standard"
              : "review.freeStyle",
          ),
        });
        const preview = document.createElement("div");
        preview.className = "review-preview";
        const previewButton = Button(text("review.preview"), {
          onClick: () => {
            if (busy) return;
            closePreview();
            preview.replaceChildren(para("common.loading"));
            const previewId = ++generation;
            void window
              .RadaAppHost!.mount(
                {
                  appId: version.appId,
                  manifest: version.manifest,
                  artifactUrl: version.artifactUrl,
                  artifactSha256: version.artifactSha256,
                  grantedPermissions: [],
                },
                preview,
                new URL(version.artifactUrl).origin,
              )
              .then((dispose) => {
                if (!current(previewId)) {
                  dispose();
                  return;
                }
                previewDispose = dispose;
              })
              .catch(() => {
                if (current(previewId))
                  preview.replaceChildren(
                    ErrorState({ message: text("review.previewFailed") }),
                  );
              });
          },
        });
        const label = document.createElement("label");
        label.textContent = text("review.reason");
        const reason = document.createElement("textarea");
        reason.maxLength = 500;
        reason.rows = 3;
        reason.required = true;
        label.append(reason);
        const actions = document.createElement("div");
        actions.className = "review-actions";
        for (const decision of ["approve", "reject"] as const)
          actions.append(
            Button(text(`review.${decision}`), {
              onClick: () => {
                if (busy || !reason.reportValidity()) return;
                if (!reason.value.trim()) {
                  reason.focus();
                  return;
                }
                busy = true;
                closePreview();
                const actionId = ++generation;
                for (const button of container.querySelectorAll("button"))
                  button.disabled = true;
                void options
                  .decide(
                    version.appId,
                    version.versionId,
                    decision,
                    reason.value,
                    lifecycle.signal,
                  )
                  .then(() => {
                    if (current(actionId)) return load();
                  })
                  .catch((error) => {
                    if (current(actionId)) errorState(error);
                  })
                  .finally(() => {
                    busy = false;
                  });
              },
            }),
          );
        row.append(
          heading,
          meta,
          declarations,
          para("review.requested"),
          requested,
          para("review.previewNotice"),
          previewButton,
          preview,
          label,
          actions,
        );
        container.append(row);
      }
    } catch (error) {
      if (current(id)) errorState(error);
    }
  }
  void load();
  return () => {
    lifecycle.abort();
    generation++;
    closePreview();
  };
}
