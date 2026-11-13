import { setButtonLoading } from "../../../packages/ui/src/index.ts";
import type {
  CommandResult,
  Mission,
  ReportInput,
  VerifyInput,
} from "../contract.ts";
import type { Client } from "./client.ts";
import type { Translator } from "./forms.ts";
import { ReputationError } from "./model.ts";
import type { recoveryStore } from "./recovery.ts";
export type Pending = { body: VerifyInput; attempted: boolean };
const definitive = (error: unknown) =>
  error instanceof ReputationError &&
  [400, 403, 409, 422].includes(error.status);
export function commandActions(
  client: Client,
  recovery: ReturnType<typeof recoveryStore>,
  pending: Map<string, Pending>,
  options: {
    text: Translator;
    active(): boolean;
    receipt(result: CommandResult): void;
    notice(message: string): void;
    error(error: unknown): string;
    draw(): void;
    reportRecovered(): void;
    reportMissing(requestId: string): void;
    busy: Set<string>;
  },
) {
  return {
    async report(body: ReportInput, recover: boolean) {
      recovery.add({ kind: "report", requestId: body.requestId });
      try {
        const result = await client.execute("/reports", body, recover);
        if (!options.active()) return;
        recovery.remove(body.requestId);
        options.reportRecovered();
        options.receipt(result);
      } catch (error) {
        if (options.active() && definitive(error))
          recovery.remove(body.requestId);
        throw error;
      }
    },
    async verify(mission: Mission, button: HTMLButtonElement) {
      if (options.busy.has(mission.id) || !options.active()) return;
      let draft = pending.get(mission.id);
      if (!draft) {
        draft = {
          body: {
            requestId: crypto.randomUUID(),
            missionVersion: mission.version,
          },
          attempted: false,
        };
        pending.set(mission.id, draft);
      }
      recovery.add({
        kind: "verify",
        missionId: mission.id,
        missionVersion: draft.body.missionVersion,
        requestId: draft.body.requestId,
      });
      options.busy.add(mission.id);
      setButtonLoading(button, true);
      button.textContent = options.text("checking");
      options.notice(options.text("checking"));
      try {
        const recover = draft.attempted;
        draft.attempted = true;
        const result = await client.execute(
          `/missions/${encodeURIComponent(mission.id)}/verify`,
          draft.body,
          recover,
        );
        if (!options.active()) return;
        pending.delete(mission.id);
        recovery.remove(draft.body.requestId);
        options.busy.delete(mission.id);
        options.receipt(result);
      } catch (error) {
        if (options.active()) {
          if (definitive(error)) {
            recovery.remove(draft.body.requestId);
            pending.delete(mission.id);
          }
          options.notice(
            pending.has(mission.id)
              ? options.text("uncertain")
              : options.error(error),
          );
        }
      } finally {
        options.busy.delete(mission.id);
        if (options.active()) options.draw();
      }
    },
    async recoverCommands() {
      for (const entry of recovery.list()) {
        if (entry.kind === "appeal") continue;
        try {
          const result = await client.command(entry.requestId);
          if (!options.active()) return;
          recovery.remove(entry.requestId);
          if (entry.kind === "verify") pending.delete(entry.missionId);
          else options.reportRecovered();
          options.receipt(result);
        } catch (error) {
          if (options.active() && entry.kind === "report") {
            if (error instanceof ReputationError && error.status === 404)
              options.reportMissing(entry.requestId);
            options.notice(options.text("recoveryHint"));
          }
        }
      }
    },
  };
}
