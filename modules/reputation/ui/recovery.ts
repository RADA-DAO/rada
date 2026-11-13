/** Only opaque command metadata is retained, never report text or evidence. */
export type PendingCommand =
  | {
      requestId: string;
      kind: "verify";
      missionId: string;
      missionVersion: number;
    }
  | { requestId: string; kind: "report" }
  | { requestId: string; kind: "appeal"; itemId: string };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
const key = (actor: string) =>
  `rada:reputation:pending:${encodeURIComponent(actor)}`;
export function recoveryStore(actor: string | null, storage?: Storage) {
  let commands: PendingCommand[] = [];
  if (actor && storage) {
    try {
      const value: unknown = JSON.parse(storage.getItem(key(actor)) ?? "[]");
      if (Array.isArray(value))
        commands = value
          .filter((entry: unknown): entry is PendingCommand => {
            if (!entry || typeof entry !== "object") return false;
            const v = entry as Record<string, unknown>;
            return (
              typeof v.requestId === "string" &&
              /^[0-9a-f-]{36}$/i.test(v.requestId) &&
              (v.kind === "report" ||
                (v.kind === "appeal" &&
                  typeof v.itemId === "string" &&
                  v.itemId.length > 0 &&
                  v.itemId.length <= 200) ||
                (v.kind === "verify" &&
                  typeof v.missionId === "string" &&
                  v.missionId.length > 0 &&
                  v.missionId.length <= 200 &&
                  Number.isSafeInteger(v.missionVersion) &&
                  Number(v.missionVersion) > 0))
            );
          })
          .slice(-30);
    } catch {
      /* Unavailable storage does not prevent participation. */
    }
  }
  function save() {
    if (actor && storage) {
      try {
        if (commands.length)
          storage.setItem(key(actor), JSON.stringify(commands));
        else storage.removeItem(key(actor));
      } catch {
        /* In-memory retry identity remains intact. */
      }
    }
  }
  return {
    list: () => [...commands],
    add(command: PendingCommand) {
      commands = [
        ...commands.filter((entry) => entry.requestId !== command.requestId),
        command,
      ].slice(-30);
      save();
    },
    remove(requestId: string) {
      commands = commands.filter((entry) => entry.requestId !== requestId);
      save();
    },
  };
}
