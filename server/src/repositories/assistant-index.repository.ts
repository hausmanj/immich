import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, sql, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema';
import { AssistantIndexRunTable } from 'src/schema/tables/assistant-index-run.table';

export type AssistantIndexRunFilter = {
  libraryId?: string | null;
  originalPathPrefix?: string | null;
};

@Injectable()
export class AssistantIndexRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  createRun(run: Insertable<AssistantIndexRunTable>) {
    return this.db.insertInto('assistant_index_run').values(run).returningAll().executeTakeFirstOrThrow();
  }

  updateRun(id: string, run: Updateable<AssistantIndexRunTable>) {
    return this.db
      .updateTable('assistant_index_run')
      .set(run)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  getRun(ownerId: string, id: string) {
    return this.db
      .selectFrom('assistant_index_run')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  getRuns(ownerId: string) {
    return this.db
      .selectFrom('assistant_index_run')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .orderBy('createdAt', 'desc')
      .limit(25)
      .execute();
  }

  async indexImportedAssets(runId: string, ownerId: string, filters: AssistantIndexRunFilter): Promise<number> {
    const libraryId = filters.libraryId ?? null;
    const originalPathLike = filters.originalPathPrefix ? `${filters.originalPathPrefix}%` : null;
    const { rows } = await sql<{ count: number }>`
      with inserted as (
        insert into "assistant_index_asset" (
          "runId",
          "assetId",
          "ownerId",
          "libraryId",
          "originalPath",
          "sourceDirectory",
          "originalFileName",
          "fileExtension",
          "type",
          "fileSizeInByte",
          "width",
          "height",
          "duration",
          "localDateTime",
          "dateTimeOriginal",
          "cameraMake",
          "cameraModel",
          "city",
          "state",
          "country",
          "checksumAlgorithm",
          "isExternal",
          "isEdited",
          "hasGps",
          "hasCamera",
          "noiseLabels",
          "riskLabels",
          "evidence"
        )
        select
          ${runId}::uuid,
          a.id,
          a."ownerId",
          a."libraryId",
          a."originalPath",
          regexp_replace(a."originalPath", '/[^/]+$', ''),
          a."originalFileName",
          nullif(lower(substring(a."originalFileName" from '\\.([^.]+)$')), ''),
          a.type::text,
          ae."fileSizeInByte",
          a.width,
          a.height,
          a.duration,
          a."localDateTime",
          ae."dateTimeOriginal",
          ae.make,
          ae.model,
          ae.city,
          ae.state,
          ae.country,
          a."checksumAlgorithm"::text,
          a."isExternal",
          a."isEdited",
          ae.latitude is not null and ae.longitude is not null,
          coalesce(ae.make, ae.model) is not null,
          array_remove(array[
            case
              when a."originalFileName" ~* '(^|[_ .-])(thumb|thumbnail|preview|icon|avatar|sticker|tmp|temp|cache)([_ .-]|$)'
                or a."originalPath" ~* '/(thumbs?|thumbnails?|previews?|cache|icons?)/'
                then 'filename_or_path_noise'
            end,
            case
              when a.type = 'IMAGE'
                and coalesce(a.width, ae."exifImageWidth") is not null
                and coalesce(a.height, ae."exifImageHeight") is not null
                and coalesce(a.width, ae."exifImageWidth") <= 256
                and coalesce(a.height, ae."exifImageHeight") <= 256
                then 'tiny_image'
            end,
            case
              when ae."fileSizeInByte" is not null and ae."fileSizeInByte"::bigint <= 100000
                then 'small_file'
            end,
            case
              when a."originalFileName" ~* '^(screenshot|screen shot)'
                then 'screenshot'
            end,
            case
              when a."originalPath" ~* '(message attachments|messages|imessage)'
                then 'message_attachment'
            end
          ]::text[], null),
          array_remove(array[
            case when ae."assetId" is null then 'no_exif' end,
            case when ae.latitude is null or ae.longitude is null then 'no_gps' end,
            case when coalesce(ae.make, ae.model) is null then 'unknown_camera' end,
            case when a."checksumAlgorithm"::text = 'sha1-path' then 'path_checksum_only' end,
            case when a."isEdited" then 'edited_asset' end,
            case when ae."fileSizeInByte" is null then 'no_file_size' end,
            case
              when a.type = 'IMAGE'
                and coalesce(a.width, ae."exifImageWidth") is not null
                and coalesce(a.height, ae."exifImageHeight") is not null
                and (coalesce(a.width, ae."exifImageWidth") < 1024 or coalesce(a.height, ae."exifImageHeight") < 1024)
                then 'low_resolution'
            end,
            case when a.type = 'VIDEO' and a.duration is null then 'video_no_duration' end
          ]::text[], null),
          jsonb_build_object(
            'sourceDirectory', regexp_replace(a."originalPath", '/[^/]+$', ''),
            'fileCreatedAt', a."fileCreatedAt",
            'fileModifiedAt', a."fileModifiedAt",
            'uploadedAt', a."createdAt",
            'updatedAt', a."updatedAt",
            'exifImageWidth', ae."exifImageWidth",
            'exifImageHeight', ae."exifImageHeight",
            'orientation', ae.orientation,
            'timeZone', ae."timeZone",
            'latitude', ae.latitude,
            'longitude', ae.longitude,
            'lensModel', ae."lensModel",
            'rating', ae.rating
          )
        from asset a
        left join asset_exif ae on ae."assetId" = a.id
        where a."ownerId" = ${ownerId}
          and a."deletedAt" is null
          and (${libraryId}::uuid is null or a."libraryId" = ${libraryId}::uuid)
          and (${originalPathLike}::text is null or a."originalPath" like ${originalPathLike})
        on conflict do nothing
        returning 1
      )
      select count(*)::int as count from inserted
    `.execute(this.db);

    return rows[0]?.count ?? 0;
  }

  async rebuildGroups(runId: string): Promise<number> {
    await this.db.deleteFrom('assistant_index_group').where('runId', '=', runId).execute();

    const inserts = [
      sql`insert into "assistant_index_group" ("runId", "groupType", "groupKey", "label", "assetCount", "confidence", "evidence")
        select ${runId}::uuid, 'source_directory', "sourceDirectory", "sourceDirectory", count(*)::int, 0.72,
          jsonb_build_object(
            'noiseCount', count(*) filter (where cardinality("noiseLabels") > 0),
            'riskCount', count(*) filter (where cardinality("riskLabels") > 0),
            'dateStart', min("localDateTime"),
            'dateEnd', max("localDateTime")
          )
        from "assistant_index_asset"
        where "runId" = ${runId}::uuid
        group by "sourceDirectory"`,
      sql`insert into "assistant_index_group" ("runId", "groupType", "groupKey", "label", "assetCount", "confidence", "evidence")
        select ${runId}::uuid, 'file_extension', coalesce("fileExtension", 'unknown'), coalesce("fileExtension", 'unknown'), count(*)::int, 0.8,
          jsonb_build_object('typeCount', jsonb_object_agg(type, type_count))
        from (
          select "fileExtension", type, count(*)::int as type_count
          from "assistant_index_asset"
          where "runId" = ${runId}::uuid
          group by "fileExtension", type
        ) counts
        group by "fileExtension"`,
      sql`insert into "assistant_index_group" ("runId", "groupType", "groupKey", "label", "assetCount", "confidence", "evidence")
        select ${runId}::uuid, 'camera', coalesce("cameraMake", 'Unknown make') || ' ' || coalesce("cameraModel", 'Unknown model'),
          coalesce("cameraMake", 'Unknown make') || ' ' || coalesce("cameraModel", 'Unknown model'), count(*)::int, 0.78,
          jsonb_build_object('dateStart', min("localDateTime"), 'dateEnd', max("localDateTime"))
        from "assistant_index_asset"
        where "runId" = ${runId}::uuid
        group by "cameraMake", "cameraModel"`,
      sql`insert into "assistant_index_group" ("runId", "groupType", "groupKey", "label", "assetCount", "confidence", "evidence")
        select ${runId}::uuid, 'noise_label', label, label, count(*)::int, 0.86,
          jsonb_build_object('sourceDirectoryCount', count(distinct "sourceDirectory"))
        from "assistant_index_asset", unnest("noiseLabels") as label
        where "runId" = ${runId}::uuid
        group by label`,
      sql`insert into "assistant_index_group" ("runId", "groupType", "groupKey", "label", "assetCount", "confidence", "evidence")
        select ${runId}::uuid, 'risk_label', label, label, count(*)::int, 0.82,
          jsonb_build_object('sourceDirectoryCount', count(distinct "sourceDirectory"))
        from "assistant_index_asset", unnest("riskLabels") as label
        where "runId" = ${runId}::uuid
        group by label`,
      sql`insert into "assistant_index_group" ("runId", "groupType", "groupKey", "label", "assetCount", "confidence", "evidence")
        select ${runId}::uuid, 'location', coalesce(country, 'Unknown country') || ' / ' || coalesce(state, 'Unknown state') || ' / ' || coalesce(city, 'Unknown city'),
          coalesce(country, 'Unknown country') || ' / ' || coalesce(state, 'Unknown state') || ' / ' || coalesce(city, 'Unknown city'),
          count(*)::int, 0.76,
          jsonb_build_object('gpsCount', count(*) filter (where "hasGps"), 'dateStart', min("localDateTime"), 'dateEnd', max("localDateTime"))
        from "assistant_index_asset"
        where "runId" = ${runId}::uuid
          and (country is not null or state is not null or city is not null)
        group by country, state, city`,
    ];

    for (const insert of inserts) {
      await insert.execute(this.db);
    }

    const { rows } = await sql<{ count: number }>`
      select count(*)::int as count from "assistant_index_group" where "runId" = ${runId}::uuid
    `.execute(this.db);

    return rows[0]?.count ?? 0;
  }

  async getRunSummary(runId: string): Promise<Record<string, unknown>> {
    const { rows } = await sql<Record<string, unknown>>`
      select
        count(*)::int as "indexedAssetCount",
        count(*) filter (where cardinality("noiseLabels") > 0)::int as "noiseCandidateCount",
        count(*) filter (where cardinality("riskLabels") > 0)::int as "riskCandidateCount",
        count(*) filter (where "hasGps")::int as "gpsAssetCount",
        count(*) filter (where not "hasGps")::int as "noGpsAssetCount",
        count(*) filter (where "hasCamera")::int as "cameraAssetCount",
        count(*) filter (where not "hasCamera")::int as "unknownCameraAssetCount",
        count(*) filter (where "checksumAlgorithm" = 'sha1-path')::int as "pathChecksumAssetCount",
        count(distinct "sourceDirectory")::int as "sourceDirectoryCount",
        count(distinct "fileExtension")::int as "fileExtensionCount",
        min("localDateTime") as "dateStart",
        max("localDateTime") as "dateEnd",
        coalesce(sum("fileSizeInByte"), 0)::text as "totalFileSizeInByte"
      from "assistant_index_asset"
      where "runId" = ${runId}::uuid
    `.execute(this.db);

    const groupCounts = await this.db
      .selectFrom('assistant_index_group')
      .select(['groupType'])
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('runId', '=', runId)
      .groupBy('groupType')
      .execute();

    const summary = rows[0];

    return {
      ...summary,
      groupCounts,
      note:
        'This is read-only assistant index evidence for imported Immich assets. It does not move, delete, tag, or alter source files.',
    };
  }

  getGroups(runId: string, limit = 100) {
    return this.db
      .selectFrom('assistant_index_group')
      .selectAll()
      .where('runId', '=', runId)
      .orderBy('assetCount', 'desc')
      .limit(limit)
      .execute();
  }
}
