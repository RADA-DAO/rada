import type pg from "pg";
import type { ArtworkImage } from "./storage.ts";

export type ServedArtwork = ArtworkImage & {
  sha256: string;
  isPublic: boolean;
};
export type ArtworkReference = { frog_id: string; sha256: string };
export interface ArtworkStore {
  image(id: string, viewer: string | null): Promise<ServedArtwork | null>;
  references(ids: string[], viewer: string | null): Promise<ArtworkReference[]>;
}
export const artworkPath = (id: string, hash: string) =>
  `/v1/frogs/${id}/artwork/${hash}`;

/** The resolver accepts only an already verified Telegram identity. */
export class PostgresArtworkStore implements ArtworkStore {
  constructor(
    private service: pg.Pool,
    private resolve: (viewer: string) => Promise<string>,
  ) {}
  private async scoped<T>(
    viewer: string | null,
    read: (c: pg.PoolClient) => Promise<T>,
  ) {
    const subject = viewer ? await this.resolve(viewer) : "";
    const client = await this.service.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('rada.subject_id', $1, true)", [
        subject,
      ]);
      const result = await read(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  references(ids: string[], viewer: string | null) {
    return this.scoped(
      viewer,
      async (c) =>
        (
          await c.query<ArtworkReference>(
            "SELECT frog_id, sha256 FROM jpegpe.visible_artwork($1::uuid[])",
            [ids],
          )
        ).rows,
    );
  }
  image(id: string, viewer: string | null) {
    return this.scoped(viewer, async (c) => {
      const row = (
        await c.query<{
          content_type: string;
          needs_normalization: boolean;
          bytes: Uint8Array;
          sha256: string;
          is_public: boolean;
        }>("SELECT * FROM jpegpe.read_artwork($1::uuid)", [id])
      ).rows[0];
      return row
        ? {
            contentType: row.content_type,
            needsNormalization: row.needs_normalization,
            bytes: row.bytes,
            sha256: row.sha256,
            isPublic: row.is_public,
          }
        : null;
    });
  }
}
