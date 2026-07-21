import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "assistant_index_asset" ADD "inventoryKind" character varying NOT NULL DEFAULT 'asset';`.execute(
    db,
  );
  await sql`ALTER TABLE "assistant_index_asset" ADD "contentSha1" character varying;`.execute(db);
  await sql`ALTER TABLE "assistant_index_asset" ADD "contentHashStatus" character varying;`.execute(db);
  await sql`ALTER TABLE "assistant_index_asset" ADD "contentHashError" character varying;`.execute(db);
  await sql`ALTER TABLE "assistant_index_asset" ADD "contentHashComputedAt" timestamp with time zone;`.execute(db);
  await sql`CREATE INDEX "assistant_index_asset_inventoryKind_idx" ON "assistant_index_asset" ("inventoryKind");`.execute(
    db,
  );
  await sql`CREATE INDEX "assistant_index_asset_contentSha1_idx" ON "assistant_index_asset" ("contentSha1");`.execute(db);
  await sql`CREATE UNIQUE INDEX "assistant_index_asset_runId_originalPath_idx" ON "assistant_index_asset" ("runId", "originalPath");`.execute(
    db,
  );
}

export async function down(): Promise<void> {
  // not supported
}
