import { Buffer } from "node:buffer";
import type pg from "pg";
export type ArtworkImage = {
  contentType: string;
  needsNormalization: boolean;
  bytes: Uint8Array;
};
type Connection = Pick<pg.Client, "query">;
/** Import-only storage contract; callers supply the batch transaction. */
export interface ImageStorage {
  save(client: Connection, frogId: string, image: ArtworkImage): Promise<void>;
  load(client: Connection, frogId: string): Promise<ArtworkImage | null>;
}
export class PostgresImageStorage implements ImageStorage {
  async save(client: Connection, id: string, image: ArtworkImage) {
    await client.query("SELECT jpegpe.import_artwork($1,$2,$3,$4)", [
      id,
      image.contentType,
      image.needsNormalization,
      Buffer.from(image.bytes),
    ]);
  }
  async load(client: Connection, id: string): Promise<ArtworkImage | null> {
    const result = await client.query<{
      content_type: string;
      needs_normalization: boolean;
      bytes: Buffer;
    }>("SELECT * FROM jpegpe.import_artwork_state($1)", [id]);
    const row = result.rows[0];
    return row
      ? {
          contentType: row.content_type,
          needsNormalization: row.needs_normalization,
          bytes: row.bytes,
        }
      : null;
  }
}
