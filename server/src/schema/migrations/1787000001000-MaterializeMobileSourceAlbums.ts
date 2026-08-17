import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TEMP TABLE immich_mobile_source_albums (
      "ownerId" uuid NOT NULL,
      "sourceAlbumId" text NOT NULL,
      "albumName" character varying NOT NULL,
      "thumbnailAssetId" uuid,
      PRIMARY KEY ("ownerId", "sourceAlbumId")
    ) ON COMMIT DROP
  `.execute(db);

  await sql`
    INSERT INTO immich_mobile_source_albums ("ownerId", "sourceAlbumId", "albumName", "thumbnailAssetId")
    SELECT
      a."ownerId",
      source_album->>'id',
      source_album->>'name',
      min(a.id::text)::uuid
    FROM asset_metadata metadata
    INNER JOIN asset a ON a.id = metadata."assetId"
    CROSS JOIN LATERAL jsonb_array_elements(metadata.value->'sourceAlbums') source_album
    WHERE metadata.key = 'mobile-app'
      AND a."deletedAt" IS NULL
      AND jsonb_typeof(metadata.value->'sourceAlbums') = 'array'
      AND source_album->>'backupSelection' = 'selected'
      AND source_album->>'isIosSharedAlbum' IS DISTINCT FROM 'true'
      AND source_album->>'id' IS NOT NULL
      AND source_album->>'name' IS NOT NULL
    GROUP BY a."ownerId", source_album->>'id', source_album->>'name'
  `.execute(db);

  // Reuse a manually-created album with the same owner and name before creating a new one.
  await sql`
    UPDATE album existing
    SET "sourceAlbumId" = source."sourceAlbumId",
        "albumThumbnailAssetId" = COALESCE(existing."albumThumbnailAssetId", source."thumbnailAssetId")
    FROM immich_mobile_source_albums source
    WHERE existing."sourceAlbumId" IS NULL
      AND existing."deletedAt" IS NULL
      AND existing."albumName" = source."albumName"
      AND EXISTS (
        SELECT 1
        FROM album_user owner
        WHERE owner."albumId" = existing.id
          AND owner."userId" = source."ownerId"
          AND owner.role = 'owner'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM album linked
        INNER JOIN album_user linked_owner ON linked_owner."albumId" = linked.id
        WHERE linked."sourceAlbumId" = source."sourceAlbumId"
          AND linked_owner."userId" = source."ownerId"
          AND linked_owner.role = 'owner'
      )
  `.execute(db);

  await sql`
    INSERT INTO album ("albumName", "sourceAlbumId", "albumThumbnailAssetId")
    SELECT source."albumName", source."sourceAlbumId", source."thumbnailAssetId"
    FROM immich_mobile_source_albums source
    WHERE NOT EXISTS (
      SELECT 1
      FROM album existing
      INNER JOIN album_user owner ON owner."albumId" = existing.id
      WHERE existing."sourceAlbumId" = source."sourceAlbumId"
        AND owner."userId" = source."ownerId"
        AND owner.role = 'owner'
    )
  `.execute(db);

  await sql`
    INSERT INTO album_user ("albumId", "userId", role)
    SELECT album.id, source."ownerId", 'owner'
    FROM immich_mobile_source_albums source
    INNER JOIN album ON album."sourceAlbumId" = source."sourceAlbumId"
    WHERE NOT EXISTS (
      SELECT 1
      FROM album_user owner
      WHERE owner."albumId" = album.id
        AND owner."userId" = source."ownerId"
    )
      AND NOT EXISTS (
        SELECT 1
        FROM album_user other_owner
        WHERE other_owner."albumId" = album.id
          AND other_owner.role = 'owner'
          AND other_owner."userId" <> source."ownerId"
      )
  `.execute(db);

  await sql`
    INSERT INTO album_asset ("albumId", "assetId")
    SELECT album.id, metadata."assetId"
    FROM asset_metadata metadata
    INNER JOIN asset a ON a.id = metadata."assetId"
    CROSS JOIN LATERAL jsonb_array_elements(metadata.value->'sourceAlbums') source_album
    INNER JOIN album ON album."sourceAlbumId" = source_album->>'id' AND album."sourceAlbumId" IS NOT NULL
    INNER JOIN album_user owner ON owner."albumId" = album.id AND owner.role = 'owner' AND owner."userId" = a."ownerId"
    WHERE metadata.key = 'mobile-app'
      AND a."deletedAt" IS NULL
      AND jsonb_typeof(metadata.value->'sourceAlbums') = 'array'
      AND source_album->>'backupSelection' = 'selected'
      AND source_album->>'isIosSharedAlbum' IS DISTINCT FROM 'true'
    ON CONFLICT DO NOTHING
  `.execute(db);
}

export async function down(_db: Kysely<any>): Promise<void> {
  // Source album memberships are intentionally retained if this migration is rolled back.
}
