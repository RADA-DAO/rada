import {
  Actions,
  Button,
  Embed,
  EmptyState,
  ErrorState,
  Field,
  List,
  ListItem,
  Loading,
  Text,
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
  const para = (key: MessageKey) => Text(text(key));
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
  function versionItem(version: ReviewVersion) {
    const requested = List({
      marked: true,
      children: version.manifest.permissions.map((permission) =>
        ListItem({ title: text(`review.permissions.${permission}`) }),
      ),
    });
    const declarations = Text(
      t(options.locale, "review.declarations", {
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
      }),
    );
    const preview = Embed();
    const previewButton = Button(text("review.preview"), {
      onClick: () => {
        if (busy) return;
        const appHost = window.RadaAppHost;
        if (!appHost) {
          errorState(new Error("unavailable"));
          return;
        }
        closePreview();
        preview.replaceChildren(Loading({ message: text("common.loading") }));
        const previewId = ++generation;
        void appHost
          .mount(
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
    const reason = Field({
      label: text("review.reason"),
      kind: "textarea",
      maxLength: 500,
      rows: 3,
      required: true,
    });
    reason.control.addEventListener("input", () => {
      reason.setError();
    });
    const decisions = (["approve", "reject"] as const).map((decision) =>
      Button(text(`review.${decision}`), {
        variant: decision === "approve" ? "primary" : "secondary",
        onClick: () => {
          if (busy || !reason.control.reportValidity()) return;
          if (!reason.control.value.trim()) {
            reason.setError(text("review.reasonRequired"));
            reason.control.focus();
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
              reason.control.value,
              lifecycle.signal,
            )
            .then(() => {
              if (current(actionId)) return load();
            })
            .catch((error: unknown) => {
              if (current(actionId)) errorState(error);
            })
            .finally(() => {
              busy = false;
            });
        },
      }),
    );
    return ListItem({
      title: version.manifest.name,
      heading: true,
      description: `${version.appId} · ${String(version.versionNo)} · ${version.manifest.author}`,
      children: [
        declarations,
        para("review.requested"),
        requested,
        para("review.previewNotice"),
        previewButton,
        preview,
        reason.element,
        Actions(decisions),
      ],
    });
  }
  async function load() {
    const id = ++generation;
    closePreview();
    container.replaceChildren(Loading({ message: text("common.loading") }));
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
      if (versions.length)
        container.append(
          List({
            label: text("review.title"),
            children: versions.map(versionItem),
          }),
        );
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
