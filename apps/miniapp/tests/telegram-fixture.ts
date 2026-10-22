import { createHmac } from "node:crypto";

/** Synthetic Telegram launch accepted by the disposable e2e API. */
export function signedLaunch(age = 0) {
  const data = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000) - age),
    user: JSON.stringify({ id: 101 }),
  });
  const secret = createHmac("sha256", "WebAppData")
    .update("synthetic-fixture-bot-token")
    .digest();
  data.set(
    "hash",
    createHmac("sha256", secret)
      .update(
        [...data.entries()]
          .sort()
          .map(([key, value]) => `${key}=${value}`)
          .join("\n"),
      )
      .digest("hex"),
  );
  return data.toString();
}
