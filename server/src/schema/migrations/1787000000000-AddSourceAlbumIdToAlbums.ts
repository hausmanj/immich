import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album" ADD COLUMN "sourceAlbumId" text`.execute(db);
  await sql`CREATE INDEX "album_sourceAlbumId_idx" ON "album" ("sourceAlbumId") WHERE "sourceAlbumId" IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX "album_sourceAlbumId_idx"`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "sourceAlbumId"`.execute(db);
}
