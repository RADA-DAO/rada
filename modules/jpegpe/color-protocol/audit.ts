import { createHash } from "node:crypto";
import {
  COLOR_CLASS_IDS,
  COLOR_DROP_PROTOCOL_VERSION,
  EXPECTED_CLASSIFICATION_MAP_SHA256,
  EXPECTED_FULL_SPACE_POPULATIONS,
  classifyRgb,
  colorClassCode,
} from "./protocol.ts";

const FULL_SPACE = 0x1000000;
const VERIFY = process.argv.includes("--verify");
const startedAt = performance.now();
const counts = Object.fromEntries(
  COLOR_CLASS_IDS.map((id) => [id, 0]),
) as Record<string, number>;
const mapHash = createHash("sha256");
const chunk = Buffer.allocUnsafe(1024 * 1024);
let chunkOffset = 0;

function flushChunk(): void {
  if (chunkOffset > 0) mapHash.update(chunk.subarray(0, chunkOffset));
  chunkOffset = 0;
}

for (let packed = 0; packed < FULL_SPACE; packed += 1) {
  const colorClass = classifyRgb({
    r: packed >>> 16,
    g: (packed >>> 8) & 0xff,
    b: packed & 0xff,
  });
  counts[colorClass] = (counts[colorClass] ?? 0) + 1;
  chunk[chunkOffset] = colorClassCode(colorClass);
  chunkOffset += 1;
  if (chunkOffset === chunk.length) flushChunk();
}
flushChunk();

const populationMatch = COLOR_CLASS_IDS.every(
  (id) => counts[id] === EXPECTED_FULL_SPACE_POPULATIONS[id],
);
const classificationMapSha256 = mapHash.digest("hex");
const result = {
  protocolVersion: COLOR_DROP_PROTOCOL_VERSION,
  enumerationOrder: "RRGGBB ascending, class code per packed 24-bit value",
  total: FULL_SPACE,
  counts,
  populationMatch,
  classificationMapSha256,
  checksumMatch: classificationMapSha256 === EXPECTED_CLASSIFICATION_MAP_SHA256,
  elapsedMs: Math.round(performance.now() - startedAt),
};

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
if (
  VERIFY &&
  (!populationMatch ||
    classificationMapSha256 !== EXPECTED_CLASSIFICATION_MAP_SHA256)
) {
  process.exitCode = 1;
}
