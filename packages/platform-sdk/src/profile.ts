import { versionUuid } from "./review-registry.ts";
export type MembershipStatus = "member" | "not_member" | "unavailable";
export type OwnProfile = {
  subject_id: string;
  profile:
    | { visibility: "private"; public: null }
    | {
        visibility: "public";
        public: {
          frog_id: string;
          username: string;
          background_color: string | null;
          accent_color: string | null;
        };
      };
  membership: { status: MembershipStatus };
};
export type OwnFrog = NonNullable<OwnProfile["profile"]["public"]> & {
  artwork_path: string | null;
};
function validPublicFrog(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const frog = value as Record<string, unknown>;
  const color = (value: unknown) =>
    value === null ||
    (typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value));
  return (
    Object.keys(frog).length === 4 &&
    typeof frog.frog_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      frog.frog_id,
    ) &&
    typeof frog.username === "string" &&
    /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(frog.username) &&
    color(frog.background_color) &&
    color(frog.accent_color)
  );
}

export function profileAdapter(
  profileUrl: string,
  authHeaders: () => { Authorization: string } | null,
) {
  return {
    async readOwnFrogs(signal?: AbortSignal): Promise<OwnFrog[]> {
      const headers = authHeaders();
      if (!headers) throw new Error("expired");
      const response = await fetch(`${profileUrl}/frogs`, {
        headers,
        credentials: "omit",
        cache: "no-store",
        signal,
      });
      if (!response.ok)
        throw new Error(response.status === 401 ? "expired" : "unavailable");
      const value: unknown = await response.json();
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        !("frogs" in value) ||
        !Array.isArray(value.frogs) ||
        value.frogs.length > 10000 ||
        !value.frogs.every((item: unknown) => {
          if (
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            Object.keys(item).length !== 5 ||
            !("artwork_path" in item)
          )
            return false;
          const { artwork_path, ...frog } = item;
          return (
            validPublicFrog(frog) &&
            (artwork_path === null ||
              (typeof artwork_path === "string" &&
                /^\/media\/jpegpe\/[0-9a-f]{64}\.(webp|png)$/.test(
                  artwork_path,
                )))
          );
        }) ||
        new Set(value.frogs.map((frog) => frog.frog_id)).size !==
          value.frogs.length
      )
        throw new Error("unavailable");
      return value.frogs as OwnFrog[];
    },
    async selectProfileFrog(
      frogId: string | null,
      signal?: AbortSignal,
    ): Promise<void> {
      if (frogId !== null && !versionUuid.test(frogId))
        throw new Error("invalid_request");
      const headers = authHeaders();
      if (!headers) throw new Error("expired");
      const response = await fetch(`${profileUrl}/profile-frog`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ frogId }),
        credentials: "omit",
        cache: "no-store",
        signal,
      });
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "expired"
            : response.status === 409
              ? "not_owned"
              : "unavailable",
        );
      const value: unknown = await response.json();
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        !("selected" in value) ||
        value.selected !== true
      )
        throw new Error("unavailable");
    },
    async readOwnProfile() {
      const headers = authHeaders();
      if (!headers) return null;
      const response = await fetch(profileUrl, {
        headers,
        cache: "no-store",
        credentials: "omit",
      });
      if (!response.ok)
        throw new Error(response.status === 401 ? "expired" : "unavailable");
      const value: unknown = await response.json();
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 3 ||
        !("profile" in value) ||
        !("subject_id" in value) ||
        typeof value.subject_id !== "string" ||
        !value.profile ||
        typeof value.profile !== "object" ||
        Array.isArray(value.profile) ||
        Object.keys(value.profile).length !== 2 ||
        !("visibility" in value.profile) ||
        !("public" in value.profile) ||
        (value.profile.visibility === "private"
          ? value.profile.public !== null
          : value.profile.visibility === "public"
            ? !validPublicFrog(value.profile.public)
            : true) ||
        !("membership" in value) ||
        !value.membership ||
        typeof value.membership !== "object" ||
        Array.isArray(value.membership) ||
        Object.keys(value.membership).length !== 1 ||
        !("status" in value.membership) ||
        typeof value.membership.status !== "string" ||
        !["member", "not_member", "unavailable"].includes(
          value.membership.status,
        )
      )
        throw new Error("unavailable");
      return value as OwnProfile;
    },
  };
}
