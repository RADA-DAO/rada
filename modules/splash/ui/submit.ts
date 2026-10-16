import {
  Button,
  EmptyState,
  FilePicker,
  Group,
  LiveRegion,
  Loading,
  Picture,
  Section,
  setButtonLoading,
  Text,
} from "../../../packages/ui/src/index.ts";
import { SplashError } from "./api.ts";
import { aborted, errorText, type SplashContext } from "./context.ts";
import { waitMinutes } from "./format.ts";
import { ACCEPTED_TYPES, PrepareError, prepareImage } from "./image.ts";

/**
 * Submit a frog: pick a picture, convert it to a PNG within the server limits
 * on this device, preview it, upload, then show the stored result with the
 * background removed when it was a solid colour.
 */
export function mountSubmit(
  container: HTMLElement,
  context: SplashContext,
): () => void {
  const { text } = context;
  container.append(
    Text(text("splash.submitIntro")),
    Text(text("splash.submitLimits")),
  );
  if (!context.authenticated) {
    container.append(EmptyState({ message: text("splash.guest") }));
    return () => undefined;
  }
  let local: string | undefined;
  let prepared: Blob | undefined;
  const dropLocal = () => {
    if (local) URL.revokeObjectURL(local);
    local = undefined;
  };
  const preview = Group();
  const status = LiveRegion();
  const result = Group();
  const upload = Button(text("splash.upload"), {
    variant: "primary",
    disabled: true,
    onClick: () => void send(),
  });
  const picker = FilePicker({
    label: text("splash.pickImage"),
    accept: ACCEPTED_TYPES,
    onSelect: (file) => void choose(file),
  });
  container.append(picker.element, preview, upload, status, result);

  async function choose(file: File) {
    dropLocal();
    prepared = undefined;
    upload.disabled = true;
    preview.replaceChildren();
    result.replaceChildren();
    status.replaceChildren(Loading({ message: text("splash.preparing") }));
    try {
      const blob = await prepareImage(file);
      if (context.signal.aborted) return;
      prepared = blob;
      local = URL.createObjectURL(blob);
      preview.replaceChildren(
        Section({
          title: text("splash.previewTitle"),
          children: [
            Picture({
              src: local,
              alt: text("splash.previewAlt"),
              fallback: text("splash.imageMissing"),
            }),
          ],
        }),
      );
      status.replaceChildren();
      upload.disabled = false;
    } catch (error) {
      if (context.signal.aborted) return;
      status.replaceChildren(
        Text(
          text(
            error instanceof PrepareError
              ? `splash.prepare.${error.code}`
              : "splash.prepare.unsupported",
          ),
        ),
      );
    }
  }

  async function send() {
    if (!prepared) return;
    setButtonLoading(upload, true);
    status.replaceChildren(Loading({ message: text("splash.uploading") }));
    try {
      const stored = await context.client.submit(prepared, context.signal);
      prepared = undefined;
      dropLocal();
      preview.replaceChildren();
      status.replaceChildren(Text(text("splash.submitted")));
      result.replaceChildren(
        Section({
          title: text("splash.resultTitle"),
          children: [
            Picture({
              src: stored.imageUrl,
              alt: text("splash.resultAlt"),
              fallback: text("splash.imageMissing"),
            }),
            Text(
              text(
                stored.backgroundRemoved
                  ? "splash.backgroundRemoved"
                  : "splash.backgroundKept",
              ),
            ),
            Button(text("splash.backToPond"), {
              onClick: () => {
                context.back();
              },
            }),
          ],
        }),
      );
    } catch (error) {
      if (aborted(context.signal, error)) return;
      const limited =
        error instanceof SplashError && error.message === "rate_limited";
      status.replaceChildren(
        Text(
          limited
            ? text("splash.error.rate_limited", {
                minutes: waitMinutes(error.retryAfter),
              })
            : errorText(text, error),
        ),
      );
    } finally {
      setButtonLoading(upload, false);
      upload.disabled = !prepared;
    }
  }
  return dropLocal;
}
