export { registerSplashRoutes } from "./api/router.ts";
export {
  PostgresSplashStore,
  readSubmissionAuthor,
  type OwnSubmission,
  type PondFrog,
  type SplashStore,
  type SubmitResult,
} from "./api/store.ts";
export { PostgresImageStorage, type ImageStorage } from "./api/storage.ts";
export {
  readPendingClaim,
  startRoundScheduler,
  type BidResult,
  type CurrentRound,
  type OwnBid,
  type PendingClaim,
  type RoundResults,
  type RoundStore,
} from "./api/rounds.ts";
export {
  ClaimService,
  SPLASH_APP_ID,
  type ClaimPayments,
  type DrawColors,
  type StartResult,
} from "./api/claim-service.ts";
export { PostgresClaimDb, type ClaimDb, type OwnClaim } from "./api/claims.ts";
// Shared bounded PNG codec; offline callers must check dimensions before decoding.
export { decodePng, encodePng, pngDimensions } from "./api/png.ts";
