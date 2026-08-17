import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TEMP TABLE immich_mobile_source_album_merge (
      "duplicateId" uuid PRIMARY KEY,
      "canonicalId" uuid NOT NULL
    ) ON COMMIT DROP
  `.execute(db);

  // Keep the oldest source-backed album for each owner/source pair. Also merge
  // a later client-created, same-name album into that source-backed album.
  await sql`
    WITH source_albums AS (
      SELECT a.id, a."albumName", a."sourceAlbumId", owner."userId" AS "ownerId"
      FROM album a
      INNER JOIN album_user owner ON owner."albumId" = a.id AND owner.role = 'owner'
      WHERE a."sourceAlbumId" IS NOT NULL AND a."deletedAt" IS NULL
    ),
    canonical_sources AS (
      SELECT "ownerId", "sourceAlbumId", min(id::text)::uuid AS "canonicalId"
      FROM source_albums
      GROUP BY "ownerId", "sourceAlbumId"
    ),
    source_duplicates AS (
      SELECT source.id AS "duplicateId", canonical."canonicalId"
      FROM source_albums source
      INNER JOIN canonical_sources canonical
        ON canonical."ownerId" = source."ownerId"
       AND canonical."sourceAlbumId" = source."sourceAlbumId"
      WHERE source.id <> canonical."canonicalId"
    ),
    manual_duplicates AS (
      SELECT manual.id AS "duplicateId", canonical."canonicalId"
      FROM album manual
      INNER JOIN album_user manual_owner
        ON manual_owner."albumId" = manual.id AND manual_owner.role = 'owner'
      INNER JOIN source_albums source
        ON source."ownerId" = manual_owner."userId"
       AND source."albumName" = manual."albumName"
      INNER JOIN canonical_sources canonical
        ON canonical."ownerId" = source."ownerId"
       AND canonical."sourceAlbumId" = source."sourceAlbumId"
      WHERE manual."sourceAlbumId" IS NULL
        AND manual."deletedAt" IS NULL
    )
    INSERT INTO immich_mobile_source_album_merge ("duplicateId", "canonicalId")
    SELECT "duplicateId", "canonicalId" FROM source_duplicates
    UNION
    SELECT "duplicateId", "canonicalId" FROM manual_duplicates
    ON CONFLICT ("duplicateId") DO NOTHING
  `.execute(db);

  await sql`
    INSERT INTO album_asset ("albumId", "assetId")
    SELECT merge."canonicalId", membership."assetId"
    FROM immich_mobile_source_album_merge merge
    INNER JOIN album_asset membership ON membership."albumId" = merge."duplicateId"
    ON CONFLICT DO NOTHING
  `.execute(db);

  await sql`
    UPDATE activity
    SET "albumId" = merge."canonicalId"
    FROM immich_mobile_source_album_merge merge
    WHERE activity."albumId" = merge."duplicateId"
      AND EXISTS (
        SELECT 1 FROM album_asset membership
        WHERE membership."albumId" = merge."canonicalId"
          AND membership."assetId" = activity."assetId"
      )
  `.execute(db);

  await sql`
    UPDATE shared_link
    SET "albumId" = merge."canonicalId"
    FROM immich_mobile_source_album_merge merge
    WHERE shared_link."albumId" = merge."duplicateId"
  `.execute(db);

  await sql`
    INSERT INTO album_user ("albumId", "userId", role)
    SELECT merge."canonicalId", membership."userId", membership.role
    FROM immich_mobile_source_album_merge merge
    INNER JOIN album_user membership ON membership."albumId" = merge."duplicateId"
    ON CONFLICT DO NOTHING
  `.execute(db);

  await sql`
    DELETE FROM album_asset
    WHERE "albumId" IN (SELECT "duplicateId" FROM immich_mobile_source_album_merge)
  `.execute(db);

  await sql`
    DELETE FROM album_user
    WHERE "albumId" IN (SELECT "duplicateId" FROM immich_mobile_source_album_merge)
  `.execute(db);

  await sql`
    DELETE FROM album
    WHERE id IN (SELECT "duplicateId" FROM immich_mobile_source_album_merge)
  `.execute(db);
}

export async function down(_db: Kysely<any>): Promise<void> {
  // Merging duplicate albums is intentionally irreversible.
}
