import { spawn } from "node:child_process";

/** @param {string} command @param {string[]} args @param {NodeJS.ProcessEnv} env @param {string | undefined} [input] */
export async function command(command, args, env, input) {
  const child = spawn(command, args, {
    env,
    timeout: 120_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";
  child.stdout.on("data", (bytes) => {
    output += String(bytes);
  });
  child.stderr.on("data", (bytes) => {
    errorOutput += String(bytes);
  });
  const status = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code);
    });
  });
  child.stdin.on("error", () => {
    /* An unsuccessful command may close stdin early. */
  });
  child.stdin.end(input);
  if ((await status) !== 0)
    throw new Error(`${command} failed: ${errorOutput.slice(-1600)}`);
  return output.trim();
}

/** @param {string} executable @param {string[]} args @param {NodeJS.ProcessEnv} env */
export function service(executable, args, env) {
  const child = spawn(executable, args, {
    env,
    stdio: "inherit",
    detached: true,
  });
  /** @type {Error | undefined} */
  let failure;
  child.on("error", (error) => {
    failure = error;
  });
  const exited = new Promise((resolve) => child.once("close", resolve));
  return {
    child,
    check() {
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `${executable} exited before the local session completed`,
        );
    },
    async stop() {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        return;
      /** @param {NodeJS.Signals} signal */
      const terminate = (signal) => {
        try {
          process.kill(-(child.pid ?? 0), signal);
        } catch (error) {
          if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH")
            throw error;
        }
      };
      terminate("SIGTERM");
      const timeout = setTimeout(() => {
        terminate("SIGKILL");
      }, 5000);
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** @param {string} url @param {() => void} [check] @param {Record<string,string>} [headers] */
export async function waitFor(url, check = () => {}, headers = {}) {
  for (let attempt = 0; attempt < 150; attempt++) {
    check();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(500),
        headers,
      });
      if (response.ok) return;
    } catch {
      /* Listener may not be bound yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Local readiness timed out: ${url}`);
}
