/** @param {string} name */
export function archiveDate(name) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{6}Z\.tar\.age$/.test(name))
    throw new Error("Invalid archive name");
  const iso = name.replace(
    /T(\d{2})(\d{2})(\d{2})Z\.tar\.age$/,
    "T$1:$2:$3.000Z",
  );
  const date = new Date(iso);
  if (!Number.isFinite(+date) || date.toISOString() !== iso)
    throw new Error("Invalid archive date");
  return date;
}

/** Newest per 14 distinct UTC days plus newest per eight ISO weeks.
 * @param {string[]} names */
export function retention(names) {
  for (const name of names) archiveDate(name); // Validate before any deletion.
  const days = new Set();
  const weeks = new Set();
  const keep = new Set();
  for (const name of [...names].sort().reverse()) {
    const date = archiveDate(name);
    const day = date.toISOString().slice(0, 10);
    date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
    const week = date.toISOString().slice(0, 10); // ISO week's Thursday.
    if (!days.has(day) && days.size < 14) {
      days.add(day);
      keep.add(name);
    }
    if (!weeks.has(week) && weeks.size < 8) {
      weeks.add(week);
      keep.add(name);
    }
  }
  return names.filter((name) => !keep.has(name));
}

/** Only fixed non-secret fields may cross the monitoring boundary.
 * @param {string} line */
export function parseReceipt(line) {
  const receipt = /** @type {unknown} */ (JSON.parse(line));
  if (
    !receipt ||
    typeof receipt !== "object" ||
    !("version" in receipt) ||
    !("status" in receipt) ||
    !("sha256" in receipt) ||
    !("archive" in receipt) ||
    typeof receipt.sha256 !== "string" ||
    typeof receipt.archive !== "string" ||
    Object.keys(receipt).sort().join(",") !== "archive,sha256,status,version" ||
    receipt.version !== 1 ||
    receipt.status !== "verified" ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256)
  )
    throw new Error("Invalid backup receipt");
  archiveDate(receipt.archive);
  return receipt;
}
