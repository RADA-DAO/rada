export { verifyTelegramInitData } from "./api/auth.ts";
export {
  TelegramMembershipProvider,
  MEMBERSHIP_CACHE_TTL_MS,
  MEMBERSHIP_CACHE_MAX_SIZE,
  unavailableMembership,
  type MembershipProvider,
  type MembershipStatus,
} from "./api/membership.ts";
export {
  PostgresIdentityStore,
  type IdentityStore,
  type Me,
} from "./api/store.ts";
export { registerIdentityRoutes } from "./api/router.ts";
export { resolveTelegramSubject } from "./api/subject.ts";
export {
  identityAuthPolicy,
  telegramAuthenticator,
  registerStagingGuard,
  type IdentityAuthPolicy,
} from "./api/policy.ts";
export { governanceMembershipSnapshot } from "./api/governance-membership.ts";
