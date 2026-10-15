import { execFileSync } from "node:child_process";
import { conventional } from "./check.mjs";

const range = process.env.COMMIT_RANGE;
const subjects = execFileSync(
  "git",
  ["log", "--format=%s", ...(range ? [range] : ["--all"])],
  { encoding: "utf8" },
)
  .trim()
  .split("\n");
for (const subject of subjects) {
  if (!conventional(subject))
    throw new Error(`Invalid Conventional Commit: ${subject}`);
}
if (process.env.PR_TITLE && !conventional(process.env.PR_TITLE))
  throw new Error("Invalid pull request title");
console.log("Commit and supplied pull request titles passed.");
