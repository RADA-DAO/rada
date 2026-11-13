import type { Appeal, AppealInput } from "../contract.ts";
import type { Client } from "./client.ts";
import { appealForm, type Draft, type FormContext } from "./forms.ts";
import { ReputationError } from "./model.ts";
import type { recoveryStore } from "./recovery.ts";
/** Lost replies recover the original receipt; a missing command resumes its ID. */
export function createAppealActions(
  ctx: FormContext,
  client: Client,
  recovery: ReturnType<typeof recoveryStore>,
  drafts: Map<string, Draft<AppealInput>>,
  active: () => boolean,
  received: (appeal: Appeal) => void,
) {
  async function recover(itemId: string, requestId: string) {
    try {
      const result = await client.appealCommand(requestId);
      if (!active()) return true;
      recovery.remove(requestId);
      drafts.delete(itemId);
      received(result);
      return true;
    } catch (error) {
      if (!active()) return true;
      if (error instanceof ReputationError && error.status === 404)
        return false;
      throw error;
    }
  }
  return {
    async recover() {
      for (const entry of recovery.list())
        if (entry.kind === "appeal") {
          try {
            await recover(entry.itemId, entry.requestId);
          } catch {
            /* Keep identity for the next explicit retry. */
          }
        }
    },
    async open(itemId: string, opener: HTMLElement) {
      const previous = recovery
        .list()
        .find((entry) => entry.kind === "appeal" && entry.itemId === itemId);
      if (previous) {
        try {
          if (await recover(itemId, previous.requestId)) return;
        } catch (error) {
          ctx.notice(ctx.error(error));
          return;
        }
      }
      if (!active()) return;
      const draft = drafts.get(itemId) ?? {
        attempted: false,
        ...(previous ? { requestId: previous.requestId } : {}),
      };
      drafts.set(itemId, draft);
      appealForm(ctx, opener, draft, async (body) => {
        recovery.add({ kind: "appeal", itemId, requestId: body.requestId });
        try {
          if (draft.attempted && (await recover(itemId, body.requestId)))
            return;
          const result = await client.appeal(itemId, body);
          if (!active()) return;
          recovery.remove(body.requestId);
          drafts.delete(itemId);
          received(result);
        } catch (error) {
          if (
            active() &&
            error instanceof ReputationError &&
            [400, 403, 409, 422].includes(error.status)
          )
            recovery.remove(body.requestId);
          throw error;
        }
      });
    },
  };
}
