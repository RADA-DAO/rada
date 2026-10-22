import "@rada/ui/screens/launcher-editor.css";
import {
  Actions,
  AppTile,
  Button,
  Field,
  Group,
  openSheet,
  ReorderItem,
  Text,
} from "../../../packages/ui/src/index.ts";
import {
  emptyLayout,
  type LauncherSnapshot,
} from "../../../packages/platform-sdk/src/launcher-layout.ts";
import { installLauncherDrag } from "../../../packages/platform-sdk/src/launcher-drag.ts";
import type { Navigation } from "../../../packages/platform-sdk/src/navigation.ts";
import {
  t,
  type Locale,
  type MessageKey,
} from "../../../packages/i18n/src/index.ts";
export function editLauncher(options: {
  locale: Locale;
  navigation: Navigation;
  snapshot: LauncherSnapshot;
  apps: { id: string; name: string; iconUrl?: string }[];
  save(snapshot: LauncherSnapshot): Promise<LauncherSnapshot>;
  reload(): Promise<LauncherSnapshot>;
  updated(snapshot: LauncherSnapshot): void;
}) {
  let snapshot = structuredClone(options.snapshot),
    busy = false;
  let saved: LauncherSnapshot | undefined;
  const text = (key: MessageKey) => t(options.locale, key);
  const body = Group(),
    message = Text("", { live: "assertive" });
  const opener = document.activeElement as HTMLElement | null;
  const dialog = openSheet({
    opener,
    title: text("launcher.edit"),
    closeLabel: text("common.close"),
    navigation: options.navigation,
    children: [message, body],
    onClose() {
      if (saved) options.updated(saved);
    },
  });
  dialog.classList.add("rada-launcher-editor");
  body.classList.add("rada-launcher-editor-body");
  const draw = () => {
    const layout = snapshot.layout;
    const ids = [
      ...new Set([...layout.order, ...options.apps.map((a) => a.id)]),
    ];
    const rows: HTMLElement[] = [];
    const reorder = (id: string, to: number) => {
      const order = [...ids];
      order.splice(order.indexOf(id), 1);
      order.splice(to, 0, id);
      layout.order = order;
      draw();
    };
    const contents: Node[] = options.apps.length
      ? ids.flatMap((id, index) => {
          const app = options.apps.find((a) => a.id === id);
          if (!app) return [];
          const toggle = (key: "pinned" | "favourites", label: MessageKey) => {
            const button = Button(text(label), {
              variant: layout[key].includes(id) ? "primary" : "secondary",
              onClick() {
                layout[key] = layout[key].includes(id)
                  ? layout[key].filter((x) => x !== id)
                  : [...layout[key], id];
                draw();
              },
            });
            button.setAttribute(
              "aria-pressed",
              String(layout[key].includes(id)),
            );
            return button;
          };
          const location = Field({
            label: `${app.name}: ${text("launcher.move")}`,
            kind: "select",
            value: layout.folders.find((f) => f.apps.includes(id))?.id ?? "",
            choices: [
              { value: "", label: text("launcher.root") },
              ...layout.folders.map((f) => ({ value: f.id, label: f.name })),
            ],
            onChange(value) {
              for (const f of layout.folders)
                f.apps = f.apps.filter((a) => a !== id);
              layout.folders.find((f) => f.id === value)?.apps.push(id);
            },
          });
          const handle = Button(app.name, { variant: "ghost" });
          handle.classList.add("rada-launcher-editor-label");
          const tile = AppTile({ ...app, tier: "platform", onOpen() {} });
          const art = tile.querySelector(".rada-app-tile-art");
          if (art) handle.prepend(art);
          installLauncherDrag(
            handle,
            () => rows,
            (to) => {
              reorder(id, to);
            },
          );
          const row = ReorderItem({
            child: Group([
              handle,
              Actions([
                toggle("pinned", "launcher.pin"),
                toggle("favourites", "launcher.favourite"),
              ]),
              location.element,
            ]),
            name: app.name,
            earlier: text("launcher.up"),
            later: text("launcher.down"),
            first: index === 0,
            last: index === ids.length - 1,
            move(direction) {
              reorder(id, index + direction);
            },
          });
          row.classList.add("rada-launcher-editor-row");
          const arrows = row.lastElementChild?.querySelectorAll("button");
          for (const [index, arrow] of Array.from(arrows ?? []).entries())
            arrow.textContent = text(
              index === 0 ? "launcher.upSymbol" : "launcher.downSymbol",
            );
          rows.push(row);
          return [row];
        })
      : [];
    const folderRows: HTMLElement[] = [];
    for (const [index, folder] of layout.folders.entries()) {
      const move = (to: number) => {
        layout.folders.splice(index, 1);
        layout.folders.splice(to, 0, folder);
        draw();
      };
      const handle = Button(folder.name);
      installLauncherDrag(handle, () => folderRows, move);
      const name = Field({
        label: text("launcher.folder"),
        value: folder.name,
        maxLength: 40,
      });
      const row = ReorderItem({
        name: folder.name,
        earlier: text("launcher.up"),
        later: text("launcher.down"),
        first: index === 0,
        last: index === layout.folders.length - 1,
        move: (direction) => {
          move(index + direction);
        },
        child: Group([
          handle,
          name.element,
          Actions([
            Button(text("launcher.rename"), {
              onClick() {
                if (name.control.value.trim()) {
                  folder.name = name.control.value.trim();
                  draw();
                }
              },
            }),
            Button(text("launcher.delete"), {
              onClick() {
                layout.folders = layout.folders.filter((f) => f !== folder);
                draw();
              },
            }),
          ]),
        ]),
      });
      row.classList.add("rada-launcher-editor-row");
      folderRows.push(row);
      contents.push(row);
    }
    const name = Field({ label: text("launcher.folder"), maxLength: 40 });
    contents.push(
      name.element,
      Button(text("launcher.create"), {
        disabled: layout.folders.length >= 20,
        onClick() {
          if (name.control.value.trim()) {
            layout.folders.push({
              id: `folder:${crypto.randomUUID()}`,
              name: name.control.value.trim(),
              apps: [],
            });
            draw();
          }
        },
      }),
    );
    contents.push(
      Actions([
        Button(text("launcher.reset"), {
          onClick() {
            snapshot.layout = emptyLayout();
            draw();
          },
        }),
        Button(text("launcher.save"), {
          disabled: busy,
          onClick: () => {
            void (async () => {
              if (busy) return;
              busy = true;
              draw();
              try {
                saved = await options.save(snapshot);
                if (dialog.open) dialog.close();
                else options.updated(saved);
              } catch (error) {
                message.textContent = text(
                  error instanceof Error && error.message === "layout_conflict"
                    ? "launcher.conflict"
                    : "shell.unavailableDescription",
                );
                message.append(
                  Button(text("common.retry"), {
                    onClick: () => {
                      void (async () => {
                        try {
                          snapshot = await options.reload();
                          message.replaceChildren();
                          busy = false;
                          draw();
                        } catch {
                          message.textContent = text(
                            "shell.unavailableDescription",
                          );
                        }
                      })();
                    },
                  }),
                );
              }
            })();
          },
        }),
      ]),
    );
    body.replaceChildren(...contents);
    body.inert = busy;
  };
  draw();
}
