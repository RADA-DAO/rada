import * as physics from "../../../packages/platform-sdk/src/screen-swipe-physics.ts";
import { workspaceSwipe } from "../../../packages/ui/src/workspace-swipe.ts";

/** Install continuous gestures after the workspace first paint. */
export function installWorkspaceMotion(
  host: HTMLElement,
  options: Omit<Parameters<typeof workspaceSwipe>[1], "physics">,
) {
  return workspaceSwipe(host, { ...options, physics });
}
