// Diagnostics never contain command arguments or stdout (which may contain data).
/** @param {string} stderr @param {string[]} [secrets] */
export function sanitizeStderr(stderr, secrets = []) {
  let safe = stderr
    .replace(/-----BEGIN [\s\S]*?(?:-----END [^\n]*-----|$)/g, "[REDACTED KEY]")
    .replace(/AGE-SECRET-KEY-[A-Z0-9]+/gi, "[REDACTED KEY]")
    .replace(/age1[a-z0-9]+/g, "[REDACTED RECIPIENT]")
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[REDACTED URL]")
    .replace(
      /^.*(?:password|passphrase|secret|token|private[._ -]?key|api[._ -]?key|authorization|PGHOST|PGUSER|PGDATABASE|host|hostaddr|port|user|dbname|sslmode|conninfo|connection.string)["']?\s*[=:].*$/gim,
      "[REDACTED CREDENTIALS]",
    );
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    safe = safe.split(secret).join("[REDACTED]");
  return (
    safe
      // Strip terminal controls so stderr cannot rewrite or hide diagnostic lines.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
      .trim()
      .split(/\r?\n/)
      .slice(-20)
      .map((line) => line.slice(0, 500))
      .join("\n")
  );
}
