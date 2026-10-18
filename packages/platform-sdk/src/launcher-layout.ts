export type LauncherLayout = {
  order: string[];
  pinned: string[];
  favourites: string[];
  folders: { id: string; name: string; apps: string[] }[];
};
export type LauncherSnapshot = { version: number; layout: LauncherLayout };
export type LauncherActivity = {
  recent: string[];
  popular: { appId: string; count: number }[];
};
export const emptyLayout = (): LauncherLayout => ({
  order: [],
  pinned: [],
  favourites: [],
  folders: [],
});
const ids = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length <= 1000 &&
  v.every(
    (x) => typeof x === "string" && /^[a-z][a-z0-9_.:-]{0,127}$/.test(x),
  ) &&
  new Set(v).size === v.length;
const isObject = (value: unknown) =>
  value !== null && typeof value === "object";
export function validLayout(v: unknown): v is LauncherLayout {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const a = v as LauncherLayout;
  return (
    Object.keys(a).sort().join() === "favourites,folders,order,pinned" &&
    ids(a.order) &&
    ids(a.pinned) &&
    ids(a.favourites) &&
    Array.isArray(a.folders) &&
    a.folders.length <= 20 &&
    a.folders.every(
      (f) =>
        isObject(f) &&
        Object.keys(f).sort().join() === "apps,id,name" &&
        ids([f.id]) &&
        typeof f.name === "string" &&
        f.name.trim().length > 0 &&
        f.name.length <= 40 &&
        !/[\p{Cc}<>]/u.test(f.name) &&
        ids(f.apps),
    ) &&
    new Set(a.folders.map((f) => f.id)).size === a.folders.length &&
    ids(a.folders.flatMap((f) => f.apps))
  );
}
export function launcherAdapter(
  base: string,
  auth: () => { Authorization: string } | null,
) {
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const headers = auth();
    if (!headers) throw new Error("expired");
    const response = await fetch(`${base}/apps/launcher/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "omit",
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(
        response.status === 409 ? "layout_conflict" : "unavailable",
      );
    return response.json() as Promise<T>;
  }
  return {
    readLayout: () => request<LauncherSnapshot>("layout"),
    saveLayout: (snapshot: LauncherSnapshot) =>
      request<LauncherSnapshot>("layout", snapshot),
    readActivity: () => request<LauncherActivity>("activity"),
    recordOpen: (appId: string) =>
      request<LauncherActivity>("activity", { appId }),
  };
}
