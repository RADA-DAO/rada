import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppRelease } from "../src/app-host.ts";
import { buildExample } from "./build-example.ts";

const fixtureToken = "synthetic-fixture-bot-token";
export function syntheticLaunch(id: 101 | 102 = 101) {
  const data = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id }),
  });
  const secret = createHmac("sha256", "WebAppData")
    .update(fixtureToken)
    .digest();
  data.set(
    "hash",
    createHmac("sha256", secret)
      .update(
        [...data]
          .sort()
          .map(([key, value]) => `${key}=${value}`)
          .join("\n"),
      )
      .digest("hex"),
  );
  return data.toString();
}

export function localApiOrigin(value: string) {
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error(
      "The example lifecycle requires an exact loopback HTTP API origin",
    );
  return url.origin;
}

type PublishedRow = {
  appId: string;
  versionId: string;
  sha256: string;
  artifactUrl: string;
  manifest: AppRelease["manifest"];
  grantedPermissions: AppRelease["grantedPermissions"];
};
type ExampleState = {
  stage: "first" | "updated" | "rollback" | "withdrawn";
  release: AppRelease | null;
};

/** Uses only disposable synthetic identities; it cannot target a remote API. */
export async function runExampleLifecycle(options: {
  apiOrigin: string;
  artifactsDirectory: string;
  appId?: string;
  /** Used only by the interactive launcher to leave its example available. */
  seedOnly?: boolean;
  inspectRelease?(state: ExampleState): Promise<void>;
}) {
  const origin = localApiOrigin(options.apiOrigin);
  const appId = options.appId ?? `example.hello.${String(Date.now())}`;
  if (!/^example\.hello\.[a-z0-9.-]+$/.test(appId))
    throw new Error(
      "Example app IDs must use the isolated example.hello namespace",
    );
  const request = async (
    path: string,
    actor: 101 | 102 | null,
    body?: unknown,
  ) =>
    fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(actor === null
          ? {}
          : { Authorization: `tma ${syntheticLaunch(actor)}` }),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  const status = async (response: Response, expected: number) => {
    if (response.status !== expected)
      throw new Error(
        `Expected HTTP ${String(expected)}, got ${String(response.status)}: ${await response.text()}`,
      );
    return response;
  };
  const published = async () => {
    const response = await status(await request("/apps/published", 101), 200);
    return ((await response.json()) as { apps: PublishedRow[] }).apps.find(
      (row) => row.appId === appId,
    );
  };
  const transition = async (
    versionId: string,
    decision: string,
    actor: 101 | 102 = 102,
  ) =>
    status(
      await request(
        `/apps/${appId}/versions/${versionId}/${decision}`,
        actor,
        decision === "approve" ? { reason: "Reviewed local SDK example" } : {},
      ),
      200,
    );
  const inspect = async (
    stage: ExampleState["stage"],
    versionId?: string,
    sha256?: string,
  ) => {
    const row = await published();
    if (!versionId) {
      if (row) throw new Error("An unpublished/withdrawn app was exposed");
      if (stage === "withdrawn")
        await options.inspectRelease?.({ stage, release: null });
      return;
    }
    if (!row || row.versionId !== versionId || row.sha256 !== sha256)
      throw new Error(
        "Published version/hash does not match the reviewed release",
      );
    if (
      row.artifactUrl !==
      `${new URL(row.artifactUrl).origin}/artifacts/${row.sha256}.html`
    )
      throw new Error("Registry returned a noncanonical artifact path");
    await options.inspectRelease?.({
      stage,
      release: {
        appId,
        versionId: row.versionId,
        manifest: row.manifest,
        artifactUrl: row.artifactUrl,
        artifactSha256: row.sha256,
        grantedPermissions: row.grantedPermissions,
      },
    });
  };
  const first = await buildExample(options.artifactsDirectory, 1);
  const second = await buildExample(options.artifactsDirectory, 2);
  const submit = async (artifact: typeof first) => {
    const response = await status(
      await request(`/apps/${appId}/versions`, 101, {
        manifest: artifact.manifest,
        sha256: artifact.sha256,
      }),
      201,
    );
    return (await response.json()) as { versionId: string };
  };
  await status(
    await request(`/apps/${appId}/versions`, null, {
      manifest: first.manifest,
      sha256: first.sha256,
    }),
    401,
  );
  const v1 = await submit(first);
  await inspect("first");
  await status(
    await request(`/apps/${appId}/versions/${v1.versionId}/approve`, 101, {
      reason: "Not a reviewer",
    }),
    403,
  );
  await status(
    await request(`/apps/${appId}/versions/${v1.versionId}/publish`, 101, {}),
    403,
  );
  await status(
    await request(`/apps/${appId}/versions/${v1.versionId}/publish`, 102, {}),
    409,
  );
  await transition(v1.versionId, "approve");
  await transition(v1.versionId, "publish");
  await inspect("first", v1.versionId, first.sha256);
  if (options.seedOnly)
    return {
      appId,
      first: { versionId: v1.versionId, sha256: first.sha256 },
      second: null,
      status: "published" as const,
    };
  const v2 = await submit(second);
  await inspect("first", v1.versionId, first.sha256);
  await transition(v2.versionId, "approve");
  await transition(v2.versionId, "publish");
  await inspect("updated", v2.versionId, second.sha256);
  await status(
    await request(`/apps/${appId}/rollback`, 101, { versionId: v1.versionId }),
    403,
  );
  await status(
    await request(`/apps/${appId}/rollback`, 102, { versionId: v1.versionId }),
    200,
  );
  await inspect("rollback", v1.versionId, first.sha256);
  await status(
    await request(`/apps/${appId}/withdraw`, 102, {
      reason: "Local example lifecycle complete",
    }),
    200,
  );
  await inspect("withdrawn");
  return {
    appId,
    first: { versionId: v1.versionId, sha256: first.sha256 },
    second: { versionId: v2.versionId, sha256: second.sha256 },
    status: "withdrawn" as const,
  };
}

/** Publish a usable first release in the launcher's disposable environment. */
export async function seedExample(options: {
  apiOrigin: string;
  artifactsDirectory: string;
}) {
  const result: { release?: AppRelease } = {};
  await runExampleLifecycle({
    ...options,
    seedOnly: true,
    inspectRelease: (state) => {
      if (state.release) result.release = state.release;
      return Promise.resolve();
    },
  });
  if (!result.release)
    throw new Error("Example publication did not produce a release");
  return result.release;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const apiOrigin = process.env.RADA_LOCAL_API_ORIGIN;
  const artifactsDirectory = process.env.RADA_LOCAL_ARTIFACT_DIR;
  if (!apiOrigin || !artifactsDirectory)
    throw new Error(
      "Run through the local launcher: RADA_LOCAL_API_ORIGIN and RADA_LOCAL_ARTIFACT_DIR are required",
    );
  process.stdout.write(
    `${JSON.stringify(await runExampleLifecycle({ apiOrigin, artifactsDirectory }), null, 2)}\n`,
  );
}
