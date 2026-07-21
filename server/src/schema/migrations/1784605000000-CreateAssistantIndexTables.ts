import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "assistant_index_run" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "ownerId" uuid NOT NULL,
    "libraryId" uuid,
    "mode" character varying NOT NULL,
    "status" character varying NOT NULL,
    "originalPathPrefix" character varying,
    "totalAssets" integer NOT NULL DEFAULT 0,
    "indexedAssets" integer NOT NULL DEFAULT 0,
    "errorCount" integer NOT NULL DEFAULT 0,
    "parameters" jsonb NOT NULL,
    "summary" jsonb NOT NULL,
    "logFilePath" character varying,
    "startedAt" timestamp with time zone,
    "finishedAt" timestamp with time zone,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
    "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
    "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
    CONSTRAINT "assistant_index_run_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "assistant_index_run_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "library" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "assistant_index_run_pkey" PRIMARY KEY ("id")
  );`.execute(db);
  await sql`CREATE INDEX "assistant_index_run_ownerId_createdAt_idx" ON "assistant_index_run" ("ownerId", "createdAt");`.execute(
    db,
  );
  await sql`CREATE INDEX "assistant_index_run_libraryId_idx" ON "assistant_index_run" ("libraryId");`.execute(db);
  await sql`CREATE INDEX "assistant_index_run_updateId_idx" ON "assistant_index_run" ("updateId");`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "assistant_index_run_updatedAt"
    BEFORE UPDATE ON "assistant_index_run"
    FOR EACH ROW
    EXECUTE FUNCTION updated_at();`.execute(db);

  await sql`CREATE TABLE "assistant_index_asset" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "runId" uuid NOT NULL,
    "assetId" uuid,
    "ownerId" uuid NOT NULL,
    "libraryId" uuid,
    "originalPath" character varying NOT NULL,
    "sourceDirectory" character varying NOT NULL,
    "originalFileName" character varying NOT NULL,
    "fileExtension" character varying,
    "type" character varying NOT NULL,
    "fileSizeInByte" bigint,
    "width" integer,
    "height" integer,
    "duration" integer,
    "localDateTime" timestamp with time zone,
    "dateTimeOriginal" timestamp with time zone,
    "cameraMake" character varying,
    "cameraModel" character varying,
    "city" character varying,
    "state" character varying,
    "country" character varying,
    "checksumAlgorithm" character varying NOT NULL,
    "isExternal" boolean NOT NULL,
    "isEdited" boolean NOT NULL,
    "hasGps" boolean NOT NULL,
    "hasCamera" boolean NOT NULL,
    "noiseLabels" text[] NOT NULL,
    "riskLabels" text[] NOT NULL,
    "evidence" jsonb NOT NULL,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
    "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "assistant_index_asset_runId_fkey" FOREIGN KEY ("runId") REFERENCES "assistant_index_run" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "assistant_index_asset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "assistant_index_asset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "assistant_index_asset_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "library" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "assistant_index_asset_pkey" PRIMARY KEY ("id")
  );`.execute(db);
  await sql`CREATE UNIQUE INDEX "assistant_index_asset_runId_assetId_idx" ON "assistant_index_asset" ("runId", "assetId") WHERE "assetId" IS NOT NULL;`.execute(
    db,
  );
  await sql`CREATE INDEX "assistant_index_asset_runId_idx" ON "assistant_index_asset" ("runId");`.execute(db);
  await sql`CREATE INDEX "assistant_index_asset_assetId_idx" ON "assistant_index_asset" ("assetId");`.execute(db);
  await sql`CREATE INDEX "assistant_index_asset_ownerId_libraryId_idx" ON "assistant_index_asset" ("ownerId", "libraryId");`.execute(
    db,
  );
  await sql`CREATE INDEX "assistant_index_asset_sourceDirectory_idx" ON "assistant_index_asset" ("sourceDirectory");`.execute(
    db,
  );
  await sql`CREATE INDEX "assistant_index_asset_fileExtension_idx" ON "assistant_index_asset" ("fileExtension");`.execute(
    db,
  );

  await sql`CREATE TABLE "assistant_index_group" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "runId" uuid NOT NULL,
    "groupType" character varying NOT NULL,
    "groupKey" character varying NOT NULL,
    "label" character varying NOT NULL,
    "assetCount" integer NOT NULL,
    "confidence" real NOT NULL,
    "evidence" jsonb NOT NULL,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
    "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "assistant_index_group_runId_fkey" FOREIGN KEY ("runId") REFERENCES "assistant_index_run" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "assistant_index_group_pkey" PRIMARY KEY ("id")
  );`.execute(db);
  await sql`CREATE UNIQUE INDEX "assistant_index_group_runId_groupType_groupKey_idx" ON "assistant_index_group" ("runId", "groupType", "groupKey");`.execute(
    db,
  );
  await sql`CREATE INDEX "assistant_index_group_runId_groupType_idx" ON "assistant_index_group" ("runId", "groupType");`.execute(
    db,
  );

  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_assistant_index_run_updatedAt', '{"type":"trigger","name":"assistant_index_run_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"assistant_index_run_updatedAt\\"\\n  BEFORE UPDATE ON \\"assistant_index_run\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(
    db,
  );
}

export async function down(): Promise<void> {
  // not supported
}
