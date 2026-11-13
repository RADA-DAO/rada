import type { ModuleApi } from "../../../packages/platform-sdk/src/index.ts";
import type {
  AppealInput,
  Period,
  ReportInput,
  VerifyInput,
} from "../contract.ts";
import {
  appeal,
  changes,
  command,
  envelope,
  item,
  mission,
  page,
  ReputationError,
  summary,
} from "./model.ts";
export function reputationClient(api: ModuleApi, signal: AbortSignal) {
  async function read(path: string) {
    const response = await api.request("GET", `/v1/reputation${path}`, {
      auth: true,
      signal,
    });
    if (response.status < 200 || response.status >= 300)
      throw new ReputationError(response.status);
    return response.body;
  }
  async function write(path: string, body: unknown) {
    const response = await api.request("POST", `/v1/reputation${path}`, {
      auth: true,
      signal,
      body: { json: body },
    });
    if (response.status < 200 || response.status >= 300)
      throw new ReputationError(response.status);
    return response.body;
  }
  return {
    overview: async (
      view: "tasks" | "history",
      period: Period,
      cursor?: string | null,
    ) => {
      const value = await read(
        `/overview?view=${view}&period=${period}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      return {
        summary: summary(envelope(value, "summary")),
        data:
          view === "tasks"
            ? page(envelope(value, "page"), mission)
            : page(envelope(value, "page"), item),
        appeals: [],
      };
    },
    detail: async (id: string, period: Period) => {
      const [value, data, history] = await Promise.all([
        read(`/summary?period=${period}`),
        read(`/items/${encodeURIComponent(id)}`),
        read(`/items/${encodeURIComponent(id)}/appeals`),
      ]);
      const list = envelope(history, "appeals");
      if (!Array.isArray(list)) throw new ReputationError();
      return {
        summary: summary(envelope(value, "summary")),
        data: item(envelope(data, "item")),
        appeals: list.map(appeal),
      };
    },
    appealCommand: async (requestId: string) =>
      appeal(
        envelope(
          await read(`/appeals/commands/${encodeURIComponent(requestId)}`),
          "appeal",
        ),
      ),
    summary: async (period: Period) =>
      summary(envelope(await read(`/summary?period=${period}`), "summary")),
    missions: async (cursor?: string | null) =>
      page(
        await read(
          `/missions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
        mission,
      ),
    items: async (period: Period, cursor?: string | null) =>
      page(
        await read(
          `/items?period=${period}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
        item,
      ),
    item: async (id: string) =>
      item(envelope(await read(`/items/${encodeURIComponent(id)}`), "item")),
    appeals: async (id: string) => {
      const result = envelope(
        await read(`/items/${encodeURIComponent(id)}/appeals`),
        "appeals",
      );
      if (!Array.isArray(result)) throw new ReputationError();
      return result.map(appeal);
    },
    changes: async (after: string) =>
      changes(await read(`/changes?after=${after}`)),
    command: async (requestId: string) => {
      const found = command(
        await read(`/commands/${encodeURIComponent(requestId)}`),
      );
      if (found.requestId !== requestId) throw new ReputationError();
      return found;
    },
    /** On uncertain delivery, recover by ID before resending the exact command. */
    async execute(
      path: string,
      body: VerifyInput | ReportInput,
      recover: boolean,
    ) {
      if (recover) {
        try {
          const found = command(
            await read(`/commands/${encodeURIComponent(body.requestId)}`),
          );
          if (found.requestId !== body.requestId) throw new ReputationError();
          return found;
        } catch (error) {
          if (!(error instanceof ReputationError) || error.status !== 404)
            throw error;
        }
      }
      const result = command(await write(path, body));
      if (result.requestId !== body.requestId) throw new ReputationError();
      return result;
    },
    appeal: async (id: string, body: AppealInput) =>
      appeal(
        envelope(
          await write(`/items/${encodeURIComponent(id)}/appeals`, body),
          "appeal",
        ),
      ),
  };
}
export type Client = ReturnType<typeof reputationClient>;
