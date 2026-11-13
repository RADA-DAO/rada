import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { command, service } from "./local-platform-process.mjs";
import { requireFreePort } from "./local-platform-support.mjs";

/** @param {NodeJS.ProcessEnv} env */
export function wantsColimaTunnel(env) {
  const flag = env.RADA_LOCAL_COLIMA_TUNNEL;
  if (flag !== undefined && flag !== "true" && flag !== "false")
    throw new Error("RADA_LOCAL_COLIMA_TUNNEL must be true or false");
  if (flag === "true" && env.DOCKER_CONTEXT !== "colima")
    throw new Error("The owned Colima tunnel requires DOCKER_CONTEXT=colima");
  return flag === "true";
}

/** Only use the existing loopback VM endpoint, never a remote SSH target.
 * @param {string} config
 */
export function validateColimaConfig(config) {
  if (
    !/^Host colima$/m.test(config) ||
    !/^\s+Hostname 127\.0\.0\.1$/m.test(config) ||
    !/^\s+Port [0-9]+$/m.test(config)
  )
    throw new Error("Expected Colima's generated local SSH endpoint");
}

/** Independent forwarding bypasses a broken shared Colima ControlMaster.
 * The original daemon/configuration remains untouched.
 * @param {string} directory @param {number} remotePort @param {NodeJS.ProcessEnv} env
 */
export async function colimaTunnel(directory, remotePort, env) {
  if (
    !wantsColimaTunnel(env) ||
    !Number.isInteger(remotePort) ||
    remotePort < 1 ||
    remotePort > 65535
  )
    throw new Error("Invalid local Colima tunnel configuration");
  const config = await command("colima", ["ssh-config"], env);
  validateColimaConfig(config);
  const configPath = join(directory, "colima-ssh.config");
  await writeFile(configPath, config, { mode: 0o600 });
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      resolve(undefined);
    });
  });
  const address = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  if (!address || typeof address === "string")
    throw new Error("No local tunnel port");
  const port = address.port;
  const process = service(
    "ssh",
    [
      "-F",
      configPath,
      "-S",
      "none",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPersist=no",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ConnectTimeout=10",
      "-N",
      "-L",
      `127.0.0.1:${String(port)}:127.0.0.1:${String(remotePort)}`,
      "colima",
    ],
    env,
  );
  return {
    port,
    check: () => {
      process.check();
    },
    async stop() {
      await process.stop();
      await requireFreePort(port);
    },
  };
}
