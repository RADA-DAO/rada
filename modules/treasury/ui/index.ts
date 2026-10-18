export { showTreasury } from "./screen.ts";
export function loadTreasury() {
  return import("./screen.ts");
}
