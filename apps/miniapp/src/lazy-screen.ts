import { ErrorState, Loading, Screen } from "../../../packages/ui/src/index.ts";
import { t, type Locale } from "../../../packages/i18n/src/index.ts";

/** Loading belongs to the existing stack entry; late imports never mount it again. */
export function createLazyScreen() {
  let generation = 0;
  let unmount: (() => void) | undefined;
  const dispose = () => {
    generation++;
    unmount?.();
    unmount = undefined;
  };
  return {
    dispose,
    render(
      host: HTMLElement,
      options: {
        locale: Locale;
        title: string;
        brand: string;
        actions: Node[];
        load(): Promise<() => () => void>;
      },
    ) {
      dispose();
      const current = generation;
      const show = (child: Node) => {
        host.replaceChildren(
          Screen({
            title: options.title,
            brand: options.brand,
            actions: options.actions,
            children: [child],
          }),
        );
      };
      const attempt = async () => {
        if (current !== generation) return;
        show(Loading({ message: t(options.locale, "common.loading") }));
        try {
          const mount = await options.load();
          if (current === generation) unmount = mount();
        } catch {
          if (current !== generation) return;
          show(
            ErrorState({
              message: t(options.locale, "shell.unavailableDescription"),
              retryLabel: t(options.locale, "common.retry"),
              onRetry: () => void attempt(),
            }),
          );
        }
      };
      void attempt();
    },
  };
}
