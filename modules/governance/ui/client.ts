import type { ModuleApi } from "../../../packages/platform-sdk/src/index.ts";
export class GovernanceError extends Error {
  readonly status: number;
  readonly retryAfter: number | null;
  constructor(status: number, retryAfter: number | null) {
    super(String(status));
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
export function governanceClient(
  api: ModuleApi,
  signal: AbortSignal,
  authenticated = false,
) {
  async function request<T>(
    path: string,
    key: string,
    auth = authenticated,
    body?: unknown,
  ): Promise<T> {
    const response = await api.request(
      body === undefined ? "GET" : "POST",
      `/v1/governance${path}`,
      {
        auth,
        signal,
        ...(body === undefined ? {} : { body: { json: body } }),
      },
    );
    if (response.status < 200 || response.status >= 300)
      throw new GovernanceError(response.status, response.retryAfter);
    return (response.body as Record<string, T>)[key] as T;
  }
  return {
    read<T>(path: string, key: string, auth = authenticated) {
      return request<T>(path, key, auth);
    },
    write: (path: string, body: unknown) =>
      request<unknown>(path, "result", true, body),
  };
}
export type Client = ReturnType<typeof governanceClient>;
