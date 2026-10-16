import { Buffer } from "node:buffer";
import type pg from "pg";
import type { PreparedImage } from "./image.ts";

/**
 * Where frog images live. The only implementation keeps bytes in PostgreSQL
 * (bytea, capped by a table constraint); an object-storage implementation can
 * replace it without touching routes or the submission flow.
 * `save` runs inside the submission's transaction so image and record commit together.
 */
export interface ImageStorage {
  save(
    client: pg.PoolClient,
    submissionId: string,
    image: PreparedImage,
  ): Promise<void>;
  load(
    client: Pick<pg.Pool, "query">,
    submissionId: string,
  ): Promise<{ contentType: string; bytes: Uint8Array } | null>;
}

export class PostgresImageStorage implements ImageStorage {
  async save(client: pg.PoolClient, id: string, image: PreparedImage) {
    await client.query(
      "SELECT splash.store_image($1::uuid, $2, $3, $4, $5, $6)",
      [
        id,
        image.sha256,
        image.width,
        image.height,
        image.backgroundRemoved,
        Buffer.from(image.bytes),
      ],
    );
  }
  async load(client: Pick<pg.Pool, "query">, id: string) {
    const result = await client.query<{ content_type: string; bytes: Buffer }>(
      "SELECT * FROM splash.submission_image($1::uuid)",
      [id],
    );
    const row = result.rows[0];
    return row ? { contentType: row.content_type, bytes: row.bytes } : null;
  }
}
