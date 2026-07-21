import { Injectable } from '@nestjs/common';
import {
  ExpressionBuilder,
  Insertable,
  Kysely,
  NotNull,
  RawBuilder,
  Selectable,
  SelectQueryBuilder,
  ShallowDehydrateObject,
  sql,
  Updateable,
  UpdateResult,
} from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { isEmpty, isUndefined, omitBy } from 'lodash';
import { InjectKysely } from 'nestjs-kysely';
import { LockableProperty, Stack } from 'src/database';
import { Chunked, ChunkedArray, DummyValue, GenerateSql } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  AssetFileType,
  AssetOrder,
  AssetOrderBy,
  AssetStatus,
  AssetType,
  AssetVisibility,
  CalendarHeatmapType,
} from 'src/enum';
import { DB } from 'src/schema';
import { AssetAudioTable, AssetKeyframeTable, AssetVideoTable } from 'src/schema/tables/asset-av.table';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table';
import { AssetFileTable } from 'src/schema/tables/asset-file.table';
import { AssetJobStatusTable } from 'src/schema/tables/asset-job-status.table';
import { AssetMetadataTable } from 'src/schema/tables/asset-metadata.table';
import { AssetTable } from 'src/schema/tables/asset.table';
import {
  anyUuid,
  asUuid,
  hasPeople,
  removeUndefinedKeys,
  truncatedDate,
  unnest,
  withDefaultVisibility,
  withEdits,
  withExif,
  withFaces,
  withFacesAndPeople,
  withFilePath,
  withFiles,
  withLibrary,
  withOwner,
  withSmartSearch,
  withTagId,
  withTags,
} from 'src/utils/database';
import { globToSqlPattern } from 'src/utils/misc';

export type AssetStats = Record<AssetType, number>;

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface AssetStatsOptions {
  isFavorite?: boolean;
  isTrashed?: boolean;
  visibility?: AssetVisibility;
}

interface LivePhotoSearchOptions {
  ownerId: string;
  libraryId?: string | null;
  livePhotoCID: string;
  otherAssetId: string;
  type: AssetType;
}

interface AssetBuilderOptions {
  isFavorite?: boolean;
  isTrashed?: boolean;
  isDuplicate?: boolean;
  albumId?: string;
  tagId?: string;
  personId?: string;
  userIds?: string[];
  withStacked?: boolean;
  exifInfo?: boolean;
  status?: AssetStatus;
  assetType?: AssetType;
  visibility?: AssetVisibility;
  withCoordinates?: boolean;
  bbox?: BoundingBox;
}

export interface TimeBucketOptions extends AssetBuilderOptions {
  order?: AssetOrder;
  orderBy?: AssetOrderBy;
}

export interface TimeBucketItem {
  timeBucket: string;
  count: number;
}

export interface AssistantLibraryAuditSummary {
  assetCount: number;
  imageCount: number;
  videoCount: number;
  favoriteCount: number;
  archivedCount: number;
  editedCount: number;
  externalCount: number;
  gpsCount: number;
  exifCount: number;
  fileSizeCount: number;
  dimensionsCount: number;
  cameraCount: number;
  contentChecksumCount: number;
  pathChecksumCount: number;
  mobileAppMetadataCount: number;
  dateStart: string | null;
  dateEnd: string | null;
  totalFileSizeBytes: string | null;
}

export interface AssistantLibraryAuditBucket {
  key: string;
  assetCount: number;
  imageCount: number;
  videoCount: number;
  favoriteCount: number;
  archivedCount: number;
  editedCount: number;
  externalCount: number;
  gpsCount: number;
  exifCount: number;
  fileSizeCount: number;
  dimensionsCount: number;
  cameraCount: number;
  generatedLikeCount: number;
  smallDimensionCount: number;
  activeDayCount: number;
  dateSpanDays: number | null;
  distinctCameraCount: number;
  distinctPlaceCount: number;
  mobileAppMetadataCount: number;
  dateStart: string | null;
  dateEnd: string | null;
  totalFileSizeBytes: string | null;
  examples: string[];
}

export interface AssistantLocationAuditBucket extends AssistantLibraryAuditBucket {
  country: string | null;
  state: string | null;
  city: string | null;
  latitudeMin: number | null;
  latitudeMax: number | null;
  longitudeMin: number | null;
  longitudeMax: number | null;
}

export interface AssistantEventAuditBucket extends AssistantLibraryAuditBucket {
  eventKind: string;
  label: string;
  country: string | null;
  state: string | null;
  city: string | null;
  sourceDirectories: string[];
  dateSpanDays: number;
  activeDayCount: number;
  locationAssetCount: number;
  noLocationAssetCount: number;
  sourceFolderAssetCount: number;
  confidence: number;
}

export interface AssistantChecksumAuditBucket {
  checksumAlgorithm: string;
  assetCount: number;
  externalCount: number;
  examples: string[];
}

export interface AssistantDuplicateAuditBucket {
  key: string;
  assetCount: number;
  checksumAlgorithm: string | null;
  fileSizeInByte: string | null;
  width: number | null;
  height: number | null;
  dateTimeOriginal: string | null;
  examples: string[];
}

export interface AssistantVideoAuditBucket {
  key: string;
  assetCount: number;
  codecName: string | null;
  formatName: string | null;
  pixelFormat: string | null;
  durationMin: number | null;
  durationMax: number | null;
  bitrateMin: number | null;
  bitrateMax: number | null;
  examples: string[];
}

export interface AssistantMobileAppMetadataAuditBucket {
  key: string;
  assetCount: number;
  usedBaseOriginalCount: number;
  usedFallbackCount: number;
  hasAdjustmentsCount: number;
  examples: string[];
}

export interface AssistantAuditAsset {
  id: string;
  type: string;
  originalPath: string;
  originalFileName: string;
  storedChecksum: string | null;
  checksumAlgorithm: string;
  isExternal: boolean;
  isEdited: boolean;
  libraryId: string | null;
  fileSizeInByte: string | null;
  width: number | null;
  height: number | null;
  duration: string | null;
  localDateTime: string | null;
  dateTimeOriginal: string | null;
  make: string | null;
  model: string | null;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  mobileAppMetadata: unknown | null;
}

export interface AssistantAuditAssetSearch {
  cohortType?: string | null;
  cohortKey?: string | null;
  originalPathContains?: string;
  originalFileNameContains?: string;
  fileExtension?: string;
  checksumAlgorithm?: string;
  type?: string;
  takenAfter?: Date;
  takenBefore?: Date;
  make?: string;
  model?: string;
  country?: string;
  state?: string;
  city?: string;
  noGps?: boolean;
  unknownCamera?: boolean;
  hasMobileMetadata?: boolean;
}

export interface AssistantMobileOriginalComparisonBucket {
  key: string;
  mobileAssetCount: number;
  referenceAssetCount: number;
  exactTraitMatchCount: number;
  sizeMismatchCount: number;
  dimensionsMismatchCount: number;
  dateMismatchCount: number;
  cameraMismatchCount: number;
  usedBaseOriginalCount: number;
  usedFallbackCount: number;
  hasAdjustmentsCount: number;
  examples: Array<Record<string, unknown>>;
}

export interface YearMonthDay {
  day: number;
  month: number;
  year: number;
}

interface AssetExploreFieldOptions {
  maxFields: number;
  minAssetsPerField: number;
}

interface AssetGetByChecksumOptions {
  ownerId: string;
  checksum: Buffer;
  libraryId?: string;
}

interface GetByIdsRelations {
  exifInfo?: boolean;
  faces?: { person?: boolean; withDeleted?: boolean };
  files?: boolean;
  library?: boolean;
  owner?: boolean;
  smartSearch?: boolean;
  stack?: { assets?: boolean };
  tags?: boolean;
  edits?: boolean;
}

type UpsertExifOptions = {
  exif: Insertable<AssetExifTable>;
  audio?: Insertable<AssetAudioTable>;
  video?: Insertable<AssetVideoTable>;
  keyframes?: Insertable<AssetKeyframeTable>;
  lockedPropertiesBehavior: 'override' | 'append' | 'skip';
};

const distinctLocked = <T extends LockableProperty[] | null>(eb: ExpressionBuilder<DB, 'asset_exif'>, columns: T) =>
  sql<T>`nullif(array(select distinct unnest(${eb.ref('asset_exif.lockedProperties')} || ${columns})), '{}')`;

const getBoundingCircle = (bbox: BoundingBox) => {
  const { west, south, east, north } = bbox;
  const eastUnwrapped = west <= east ? east : east + 360;
  const centerLongitude = (((west + eastUnwrapped) / 2 + 540) % 360) - 180;
  const centerLatitude = (south + north) / 2;
  const radius = sql<number>`greatest(
    earth_distance(ll_to_earth_public(${centerLatitude}, ${centerLongitude}), ll_to_earth_public(${south}, ${west})),
    earth_distance(ll_to_earth_public(${centerLatitude}, ${centerLongitude}), ll_to_earth_public(${south}, ${east})),
    earth_distance(ll_to_earth_public(${centerLatitude}, ${centerLongitude}), ll_to_earth_public(${north}, ${west})),
    earth_distance(ll_to_earth_public(${centerLatitude}, ${centerLongitude}), ll_to_earth_public(${north}, ${east}))
  )`;

  return { centerLatitude, centerLongitude, radius };
};

const withBoundingBox = <T>(qb: SelectQueryBuilder<DB, 'asset' | 'asset_exif', T>, bbox: BoundingBox) => {
  const { west, south, east, north } = bbox;
  const withLatitude = qb.where('asset_exif.latitude', '>=', south).where('asset_exif.latitude', '<=', north);

  if (west <= east) {
    return withLatitude.where('asset_exif.longitude', '>=', west).where('asset_exif.longitude', '<=', east);
  }

  return withLatitude.where((eb) =>
    eb.or([eb('asset_exif.longitude', '>=', west), eb('asset_exif.longitude', '<=', east)]),
  );
};

@Injectable()
export class AssetRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({
    params: [
      {
        exif: { dateTimeOriginal: DummyValue.DATE, lockedProperties: ['dateTimeOriginal'] },
        lockedPropertiesBehavior: 'append',
      },
    ],
  })
  async upsertExif({ exif, audio, video, keyframes, lockedPropertiesBehavior }: UpsertExifOptions): Promise<void> {
    let query = this.db;
    if (audio) {
      (query as any) = this.db.with('audio', (qb) =>
        qb
          .insertInto('asset_audio')
          .values(audio)
          .onConflict((oc) =>
            oc.column('assetId').doUpdateSet(({ ref }) => ({
              bitrate: ref('asset_audio.bitrate'),
              index: ref('asset_audio.index'),
              profile: ref('asset_audio.profile'),
              codecName: ref('asset_audio.codecName'),
            })),
          ),
      );
    }

    if (video) {
      (query as any) = query.with('video', (qb) =>
        qb
          .insertInto('asset_video')
          .values(video)
          .onConflict((oc) =>
            oc.column('assetId').doUpdateSet(({ ref }) => ({
              bitrate: ref('asset_video.bitrate'),
              timeBase: ref('asset_video.timeBase'),
              index: ref('asset_video.index'),
              profile: ref('asset_video.profile'),
              level: ref('asset_video.level'),
              colorPrimaries: ref('asset_video.colorPrimaries'),
              colorTransfer: ref('asset_video.colorTransfer'),
              colorMatrix: ref('asset_video.colorMatrix'),
              dvProfile: ref('asset_video.dvProfile'),
              dvLevel: ref('asset_video.dvLevel'),
              dvBlSignalCompatibilityId: ref('asset_video.dvBlSignalCompatibilityId'),
              codecName: ref('asset_video.codecName'),
              formatName: ref('asset_video.formatName'),
              formatLongName: ref('asset_video.formatLongName'),
              pixelFormat: ref('asset_video.pixelFormat'),
            })),
          ),
      );
    }

    if (keyframes) {
      (query as any) = query.with('keyframe', (qb) =>
        qb
          .insertInto('asset_keyframe')
          .values(keyframes)
          .onConflict((oc) =>
            oc.column('assetId').doUpdateSet(({ ref }) => ({
              pts: ref('asset_keyframe.pts'),
              accDuration: ref('asset_keyframe.accDuration'),
              ownDuration: ref('asset_keyframe.ownDuration'),
              totalDuration: ref('asset_keyframe.totalDuration'),
              packetCount: ref('asset_keyframe.packetCount'),
              outputFrames: ref('asset_keyframe.outputFrames'),
            })),
          ),
      );
    }

    await query
      .insertInto('asset_exif')
      .values(exif)
      .onConflict((oc) =>
        oc.column('assetId').doUpdateSet((eb) => {
          const updateLocked = <T extends keyof AssetExifTable>(col: T) => eb.ref(`excluded.${col}`);
          const skipLocked = <T extends keyof AssetExifTable>(col: T) =>
            eb
              .case()
              .when(sql`${col}`, '=', eb.fn.any('asset_exif.lockedProperties'))
              .then(eb.ref(`asset_exif.${col}`))
              .else(eb.ref(`excluded.${col}`))
              .end();
          const ref = lockedPropertiesBehavior === 'skip' ? skipLocked : updateLocked;
          return {
            ...removeUndefinedKeys(
              {
                description: ref('description'),
                exifImageWidth: ref('exifImageWidth'),
                exifImageHeight: ref('exifImageHeight'),
                fileSizeInByte: ref('fileSizeInByte'),
                orientation: ref('orientation'),
                dateTimeOriginal: ref('dateTimeOriginal'),
                modifyDate: ref('modifyDate'),
                timeZone: ref('timeZone'),
                latitude: ref('latitude'),
                longitude: ref('longitude'),
                projectionType: ref('projectionType'),
                city: ref('city'),
                livePhotoCID: ref('livePhotoCID'),
                autoStackId: ref('autoStackId'),
                state: ref('state'),
                country: ref('country'),
                make: ref('make'),
                model: ref('model'),
                lensModel: ref('lensModel'),
                fNumber: ref('fNumber'),
                focalLength: ref('focalLength'),
                iso: ref('iso'),
                exposureTime: ref('exposureTime'),
                profileDescription: ref('profileDescription'),
                colorspace: ref('colorspace'),
                bitsPerSample: ref('bitsPerSample'),
                rating: ref('rating'),
                fps: ref('fps'),
                tags: ref('tags'),
                lockedProperties:
                  lockedPropertiesBehavior === 'append'
                    ? distinctLocked(eb, exif.lockedProperties ?? null)
                    : ref('lockedProperties'),
              },
              exif,
            ),
          };
        }),
      )
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID], { model: DummyValue.STRING }] })
  @Chunked()
  async updateAllExif(ids: string[], options: Updateable<AssetExifTable>): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.db
      .updateTable('asset_exif')
      .set((eb) => ({
        ...options,
        lockedProperties: distinctLocked(eb, Object.keys(options) as LockableProperty[]),
      }))
      .where('assetId', 'in', ids)
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.NUMBER, DummyValue.STRING] })
  @Chunked()
  updateDateTimeOriginal(ids: string[], delta?: number, timeZone?: string) {
    return this.db
      .updateTable('asset_exif')
      .set((eb) => ({
        dateTimeOriginal: sql`"dateTimeOriginal" + ${(delta ?? 0) + ' minute'}::interval`,
        timeZone,
        lockedProperties: distinctLocked(eb, ['dateTimeOriginal', 'timeZone']),
      }))
      .where('assetId', 'in', ids)
      .returning(['assetId', 'dateTimeOriginal', 'timeZone'])
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, ['description']] })
  unlockProperties(assetId: string, properties: LockableProperty[]) {
    return this.db
      .updateTable('asset_exif')
      .where('assetId', '=', assetId)
      .set((eb) => ({
        lockedProperties: sql`nullif(array(select distinct property from unnest(${eb.ref('asset_exif.lockedProperties')}) property where not property = any(${properties})), '{}')`,
      }))
      .execute();
  }

  async upsertJobStatus(...jobStatus: Insertable<AssetJobStatusTable>[]): Promise<void> {
    if (jobStatus.length === 0) {
      return;
    }

    const values = jobStatus.map((row) => ({ ...row, assetId: asUuid(row.assetId) }));
    await this.db
      .insertInto('asset_job_status')
      .values(values)
      .onConflict((oc) =>
        oc.column('assetId').doUpdateSet((eb) =>
          removeUndefinedKeys(
            {
              duplicatesDetectedAt: eb.ref('excluded.duplicatesDetectedAt'),
              facesRecognizedAt: eb.ref('excluded.facesRecognizedAt'),
              metadataExtractedAt: eb.ref('excluded.metadataExtractedAt'),
              ocrAt: eb.ref('excluded.ocrAt'),
            },
            values[0],
          ),
        ),
      )
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getMetadata(assetId: string) {
    return this.db
      .selectFrom('asset_metadata')
      .select(['key', 'value', 'updatedAt'])
      .where('assetId', '=', assetId)
      .execute();
  }

  async getAssistantLibraryAuditSummary(ownerId: string): Promise<AssistantLibraryAuditSummary> {
    const { rows } = await sql<AssistantLibraryAuditSummary>`
      select
        count(*)::int as "assetCount",
        count(*) filter (where a.type = 'IMAGE')::int as "imageCount",
        count(*) filter (where a.type = 'VIDEO')::int as "videoCount",
        count(*) filter (where a."isFavorite")::int as "favoriteCount",
        count(*) filter (where a.visibility = 'archive')::int as "archivedCount",
        count(*) filter (where a."isEdited")::int as "editedCount",
        count(*) filter (where a."isExternal")::int as "externalCount",
        count(*) filter (where ae.latitude is not null and ae.longitude is not null)::int as "gpsCount",
        count(ae."assetId")::int as "exifCount",
        count(*) filter (where ae."fileSizeInByte" is not null)::int as "fileSizeCount",
        count(*) filter (where a.width is not null and a.height is not null)::int as "dimensionsCount",
        count(*) filter (where ae.make is not null or ae.model is not null)::int as "cameraCount",
        count(*) filter (where a."checksumAlgorithm" = 'sha1')::int as "contentChecksumCount",
        count(*) filter (where a."checksumAlgorithm" = 'sha1-path')::int as "pathChecksumCount",
        count(am."assetId")::int as "mobileAppMetadataCount",
        min(a."localDateTime")::text as "dateStart",
        max(a."localDateTime")::text as "dateEnd",
        coalesce(sum(ae."fileSizeInByte"), 0)::text as "totalFileSizeBytes"
      from asset a
      left join asset_exif ae on ae."assetId" = a.id
      left join asset_metadata am on am."assetId" = a.id and am.key = 'mobile-app'
      where a."ownerId" = ${asUuid(ownerId)}
        and a."deletedAt" is null
    `.execute(this.db);

    return rows[0];
  }

  getAssistantSourcePathCohorts(ownerId: string, limit: number): Promise<AssistantLibraryAuditBucket[]> {
    return this.getAssistantAuditBuckets(ownerId, limit, this.getAssistantSourcePathCohortSql());
  }

  getAssistantDateCohorts(ownerId: string, limit: number): Promise<AssistantLibraryAuditBucket[]> {
    return this.getAssistantAuditBuckets(ownerId, limit, this.getAssistantDateCohortSql());
  }

  getAssistantCameraCohorts(ownerId: string, limit: number): Promise<AssistantLibraryAuditBucket[]> {
    return this.getAssistantAuditBuckets(ownerId, limit, this.getAssistantCameraCohortSql());
  }

  async getAssistantLocationCohorts(ownerId: string, limit: number): Promise<AssistantLocationAuditBucket[]> {
    const { rows } = await sql<AssistantLocationAuditBucket>`
      select
        case
          when ae.country is null and ae.state is null and ae.city is null
            and ae.latitude is not null and ae.longitude is not null then 'GPS without place labels'
          when ae.country is null and ae.state is null and ae.city is null then 'No visible location'
          else concat_ws(' / ', nullif(ae.country, ''), nullif(ae.state, ''), nullif(ae.city, ''))
        end as key,
        ae.country,
        ae.state,
        ae.city,
        count(*)::int as "assetCount",
        count(*) filter (where a.type = 'IMAGE')::int as "imageCount",
        count(*) filter (where a.type = 'VIDEO')::int as "videoCount",
        count(*) filter (where a."isFavorite")::int as "favoriteCount",
        count(*) filter (where a.visibility = 'archive')::int as "archivedCount",
        count(*) filter (where a."isEdited")::int as "editedCount",
        count(*) filter (where a."isExternal")::int as "externalCount",
        count(*) filter (where ae.latitude is not null and ae.longitude is not null)::int as "gpsCount",
        count(ae."assetId")::int as "exifCount",
        count(*) filter (where ae."fileSizeInByte" is not null)::int as "fileSizeCount",
        count(*) filter (where a.width is not null and a.height is not null)::int as "dimensionsCount",
        count(*) filter (where ae.make is not null or ae.model is not null)::int as "cameraCount",
        count(*) filter (where a."originalFileName" ~* '(-poster|-backdrop|-logo|-landscape|thumb|thumbnail|preview|cache|icon)')::int as "generatedLikeCount",
        count(*) filter (where a.width <= 512 and a.height <= 512)::int as "smallDimensionCount",
        count(distinct (a."localDateTime" at time zone 'UTC')::date) filter (where a."localDateTime" is not null)::int as "activeDayCount",
        (
          max((a."localDateTime" at time zone 'UTC')::date) -
          min((a."localDateTime" at time zone 'UTC')::date) +
          1
        )::int as "dateSpanDays",
        count(distinct concat_ws(' ', nullif(ae.make, ''), nullif(ae.model, ''))) filter (where ae.make is not null or ae.model is not null)::int as "distinctCameraCount",
        count(distinct concat_ws(' / ', nullif(ae.country, ''), nullif(ae.state, ''), nullif(ae.city, ''))) filter (where ae.country is not null or ae.state is not null or ae.city is not null)::int as "distinctPlaceCount",
        count(am."assetId")::int as "mobileAppMetadataCount",
        min(a."localDateTime")::text as "dateStart",
        max(a."localDateTime")::text as "dateEnd",
        coalesce(sum(ae."fileSizeInByte"), 0)::text as "totalFileSizeBytes",
        min(ae.latitude) as "latitudeMin",
        max(ae.latitude) as "latitudeMax",
        min(ae.longitude) as "longitudeMin",
        max(ae.longitude) as "longitudeMax",
        array_remove((array_agg(a."originalPath" order by a."localDateTime" desc))[1:5], null) as examples
      from asset a
      left join asset_exif ae on ae."assetId" = a.id
      left join asset_metadata am on am."assetId" = a.id and am.key = 'mobile-app'
      where a."ownerId" = ${asUuid(ownerId)}
        and a."deletedAt" is null
      group by
        case
          when ae.country is null and ae.state is null and ae.city is null
            and ae.latitude is not null and ae.longitude is not null then 'GPS without place labels'
          when ae.country is null and ae.state is null and ae.city is null then 'No visible location'
          else concat_ws(' / ', nullif(ae.country, ''), nullif(ae.state, ''), nullif(ae.city, ''))
        end,
        ae.country,
        ae.state,
        ae.city
      order by count(*) desc, 1 asc
      limit ${limit}
    `.execute(this.db);

    return rows;
  }

  async getAssistantEventCohorts(ownerId: string, limit: number): Promise<AssistantEventAuditBucket[]> {
    const { rows } = await sql<AssistantEventAuditBucket>`
      with base as (
        select
          a.*,
          ae."assetId" as "exifAssetId",
          ae."fileSizeInByte",
          ae.latitude,
          ae.longitude,
          nullif(ae.country, '') as country,
          nullif(ae.state, '') as state,
          nullif(ae.city, '') as city,
          ae.make,
          ae.model,
          (a."localDateTime" at time zone 'UTC')::date as "localDate",
          regexp_replace(a."originalPath", '/[^/]+$', '') as "sourceDirectory"
        from asset a
        left join asset_exif ae on ae."assetId" = a.id
        where a."ownerId" = ${asUuid(ownerId)}
          and a."deletedAt" is null
          and a."localDateTime" is not null
      ),
      candidates as (
        select
          'place_exact' as "eventKind",
          concat_ws(' / ', country, state, city) as label,
          country,
          state,
          city,
          min("localDate") as "dateStartDay",
          max("localDate") as "dateEndDay",
          count(*)::int as "assetCount",
          count(*) filter (where type = 'IMAGE')::int as "imageCount",
          count(*) filter (where type = 'VIDEO')::int as "videoCount",
          count(*) filter (where "isFavorite")::int as "favoriteCount",
          count(*) filter (where visibility = 'archive')::int as "archivedCount",
          count(*) filter (where "isEdited")::int as "editedCount",
          count(*) filter (where "isExternal")::int as "externalCount",
          count(*) filter (where latitude is not null and longitude is not null)::int as "gpsCount",
          count("exifAssetId")::int as "exifCount",
          count(*) filter (where "fileSizeInByte" is not null)::int as "fileSizeCount",
          count(*) filter (where width is not null and height is not null)::int as "dimensionsCount",
          count(*) filter (where make is not null or model is not null)::int as "cameraCount",
          0::int as "mobileAppMetadataCount",
          coalesce(sum("fileSizeInByte"), 0)::text as "totalFileSizeBytes",
          count(distinct "localDate")::int as "activeDayCount",
          count(*)::int as "locationAssetCount",
          array_remove((array_agg("originalPath" order by "localDateTime" desc))[1:5], null) as examples,
          array_remove(array_agg(distinct "sourceDirectory"), null) as "sourceDirectories"
        from base
        where country is not null and city is not null
        group by country, state, city
        having count(*) >= 8 and count(distinct "localDate") >= 2

        union all

        select
          'place_region' as "eventKind",
          concat_ws(' / ', country, state) as label,
          country,
          state,
          null::text as city,
          min("localDate") as "dateStartDay",
          max("localDate") as "dateEndDay",
          count(*)::int as "assetCount",
          count(*) filter (where type = 'IMAGE')::int as "imageCount",
          count(*) filter (where type = 'VIDEO')::int as "videoCount",
          count(*) filter (where "isFavorite")::int as "favoriteCount",
          count(*) filter (where visibility = 'archive')::int as "archivedCount",
          count(*) filter (where "isEdited")::int as "editedCount",
          count(*) filter (where "isExternal")::int as "externalCount",
          count(*) filter (where latitude is not null and longitude is not null)::int as "gpsCount",
          count("exifAssetId")::int as "exifCount",
          count(*) filter (where "fileSizeInByte" is not null)::int as "fileSizeCount",
          count(*) filter (where width is not null and height is not null)::int as "dimensionsCount",
          count(*) filter (where make is not null or model is not null)::int as "cameraCount",
          0::int as "mobileAppMetadataCount",
          coalesce(sum("fileSizeInByte"), 0)::text as "totalFileSizeBytes",
          count(distinct "localDate")::int as "activeDayCount",
          count(*)::int as "locationAssetCount",
          array_remove((array_agg("originalPath" order by "localDateTime" desc))[1:5], null) as examples,
          array_remove(array_agg(distinct "sourceDirectory"), null) as "sourceDirectories"
        from base
        where country is not null and state is not null
        group by country, state
        having count(*) >= 10 and count(distinct "localDate") >= 2

        union all

        select
          'place_country' as "eventKind",
          country as label,
          country,
          null::text as state,
          null::text as city,
          min("localDate") as "dateStartDay",
          max("localDate") as "dateEndDay",
          count(*)::int as "assetCount",
          count(*) filter (where type = 'IMAGE')::int as "imageCount",
          count(*) filter (where type = 'VIDEO')::int as "videoCount",
          count(*) filter (where "isFavorite")::int as "favoriteCount",
          count(*) filter (where visibility = 'archive')::int as "archivedCount",
          count(*) filter (where "isEdited")::int as "editedCount",
          count(*) filter (where "isExternal")::int as "externalCount",
          count(*) filter (where latitude is not null and longitude is not null)::int as "gpsCount",
          count("exifAssetId")::int as "exifCount",
          count(*) filter (where "fileSizeInByte" is not null)::int as "fileSizeCount",
          count(*) filter (where width is not null and height is not null)::int as "dimensionsCount",
          count(*) filter (where make is not null or model is not null)::int as "cameraCount",
          0::int as "mobileAppMetadataCount",
          coalesce(sum("fileSizeInByte"), 0)::text as "totalFileSizeBytes",
          count(distinct "localDate")::int as "activeDayCount",
          count(*)::int as "locationAssetCount",
          array_remove((array_agg("originalPath" order by "localDateTime" desc))[1:5], null) as examples,
          array_remove(array_agg(distinct "sourceDirectory"), null) as "sourceDirectories"
        from base
        where country is not null
        group by country
        having count(*) >= 12 and count(distinct "localDate") >= 2
      ),
      enriched as (
        select
          candidates.*,
          review_assets."assetCount" as "reviewAssetCount",
          review_assets."imageCount" as "reviewImageCount",
          review_assets."videoCount" as "reviewVideoCount",
          review_assets."favoriteCount" as "reviewFavoriteCount",
          review_assets."archivedCount" as "reviewArchivedCount",
          review_assets."editedCount" as "reviewEditedCount",
          review_assets."externalCount" as "reviewExternalCount",
          review_assets."gpsCount" as "reviewGpsCount",
          review_assets."exifCount" as "reviewExifCount",
          review_assets."fileSizeCount" as "reviewFileSizeCount",
          review_assets."dimensionsCount" as "reviewDimensionsCount",
          review_assets."cameraCount" as "reviewCameraCount",
          review_assets."totalFileSizeBytes" as "reviewTotalFileSizeBytes",
          review_assets."dateStartDay" as "reviewDateStartDay",
          review_assets."dateEndDay" as "reviewDateEndDay",
          review_assets."activeDayCount" as "reviewActiveDayCount",
          review_assets."noLocationAssetCount",
          review_assets."sourceFolderAssetCount",
          review_assets."sourceDirectories" as "reviewSourceDirectories",
          review_assets.examples as "reviewExamples"
        from candidates
        cross join lateral (
          select
            count(*)::int as "assetCount",
            count(*) filter (where review_asset.type = 'IMAGE')::int as "imageCount",
            count(*) filter (where review_asset.type = 'VIDEO')::int as "videoCount",
            count(*) filter (where review_asset."isFavorite")::int as "favoriteCount",
            count(*) filter (where review_asset.visibility = 'archive')::int as "archivedCount",
            count(*) filter (where review_asset."isEdited")::int as "editedCount",
            count(*) filter (where review_asset."isExternal")::int as "externalCount",
            count(*) filter (where review_asset.latitude is not null and review_asset.longitude is not null)::int as "gpsCount",
            count(review_asset."exifAssetId")::int as "exifCount",
            count(*) filter (where review_asset."fileSizeInByte" is not null)::int as "fileSizeCount",
            count(*) filter (where review_asset.width is not null and review_asset.height is not null)::int as "dimensionsCount",
            count(*) filter (where review_asset.make is not null or review_asset.model is not null)::int as "cameraCount",
            coalesce(sum(review_asset."fileSizeInByte"), 0)::text as "totalFileSizeBytes",
            min(review_asset."localDate") as "dateStartDay",
            max(review_asset."localDate") as "dateEndDay",
            count(distinct review_asset."localDate")::int as "activeDayCount",
            count(*) filter (where review_asset.country is null and review_asset.state is null and review_asset.city is null)::int as "noLocationAssetCount",
            count(*) filter (where review_asset."sourceDirectory" = any(candidates."sourceDirectories"))::int as "sourceFolderAssetCount",
            array_remove(array_agg(distinct review_asset."sourceDirectory"), null) as "sourceDirectories",
            array_remove((array_agg(review_asset."originalPath" order by review_asset."localDateTime" desc))[1:5], null) as examples
          from base review_asset
          where (
            (
              review_asset."localDate" >= candidates."dateStartDay"
              and review_asset."localDate" <= candidates."dateEndDay"
              and (
                (
                  candidates."eventKind" = 'place_country'
                  and (
                    review_asset.country = candidates.country
                    or (review_asset.country is null and review_asset.state is null and review_asset.city is null)
                  )
                )
                or (
                  candidates."eventKind" = 'place_region'
                  and (
                    (review_asset.country = candidates.country and review_asset.state = candidates.state)
                    or (review_asset.country is null and review_asset.state is null and review_asset.city is null)
                  )
                )
                or (
                  candidates."eventKind" = 'place_exact'
                  and (
                    (
                      review_asset.country = candidates.country
                      and review_asset.state is not distinct from candidates.state
                      and review_asset.city = candidates.city
                    )
                    or (review_asset.country is null and review_asset.state is null and review_asset.city is null)
                  )
                )
              )
            )
            or review_asset."sourceDirectory" = any(candidates."sourceDirectories")
          )
        ) review_assets
      )
      select
        jsonb_build_object(
          'kind', "eventKind",
          'country', country,
          'state', state,
          'city', city,
          'dateStart', "dateStartDay"::text,
          'dateEnd', "dateEndDay"::text
        )::text as key,
        "eventKind",
        label,
        country,
        state,
        city,
        "reviewSourceDirectories" as "sourceDirectories",
        "reviewAssetCount" as "assetCount",
        "reviewImageCount" as "imageCount",
        "reviewVideoCount" as "videoCount",
        "reviewFavoriteCount" as "favoriteCount",
        "reviewArchivedCount" as "archivedCount",
        "reviewEditedCount" as "editedCount",
        "reviewExternalCount" as "externalCount",
        "reviewGpsCount" as "gpsCount",
        "reviewExifCount" as "exifCount",
        "reviewFileSizeCount" as "fileSizeCount",
        "reviewDimensionsCount" as "dimensionsCount",
        "reviewCameraCount" as "cameraCount",
        "mobileAppMetadataCount",
        ("reviewDateStartDay"::timestamp)::text as "dateStart",
        ("reviewDateEndDay"::timestamp + interval '1 day' - interval '1 second')::text as "dateEnd",
        "reviewTotalFileSizeBytes" as "totalFileSizeBytes",
        ("reviewDateEndDay" - "reviewDateStartDay" + 1)::int as "dateSpanDays",
        "reviewActiveDayCount" as "activeDayCount",
        "locationAssetCount",
        "noLocationAssetCount",
        "sourceFolderAssetCount",
        round(
          least(
            0.99,
            0.45
              + least("activeDayCount", 14) * 0.025
              + least("reviewAssetCount", 120) * 0.002
              + case "eventKind" when 'place_region' then 0.12 when 'place_exact' then 0.08 else 0.04 end
          )::numeric,
          2
        )::float as confidence,
        "reviewExamples" as examples
      from enriched
      where ("dateEndDay" - "dateStartDay" + 1) between 2 and 45
      order by confidence desc, "reviewAssetCount" desc, "dateStartDay" asc, label asc
      limit ${limit}
    `.execute(this.db);

    return rows;
  }

  async getAssistantChecksumAlgorithmCohorts(ownerId: string): Promise<AssistantChecksumAuditBucket[]> {
    const { rows } = await sql<AssistantChecksumAuditBucket>`
      select
        a."checksumAlgorithm"::text as "checksumAlgorithm",
        count(*)::int as "assetCount",
        count(*) filter (where a."isExternal")::int as "externalCount",
        array_remove((array_agg(a."originalPath" order by a."localDateTime" desc))[1:5], null) as examples
      from asset a
      where a."ownerId" = ${asUuid(ownerId)}
        and a."deletedAt" is null
      group by a."checksumAlgorithm"
      order by count(*) desc
    `.execute(this.db);

    return rows;
  }

  async getAssistantExactDuplicateCandidates(ownerId: string, limit: number): Promise<AssistantDuplicateAuditBucket[]> {
    const { rows } = await sql<AssistantDuplicateAuditBucket>`
      select
        encode(a.checksum, 'base64') as key,
        count(*)::int as "assetCount",
        a."checksumAlgorithm"::text as "checksumAlgorithm",
        null::text as "fileSizeInByte",
        null::int as width,
        null::int as height,
        null::text as "dateTimeOriginal",
        array_remove((array_agg(a."originalPath" order by a."localDateTime" desc))[1:8], null) as examples
      from asset a
      where a."ownerId" = ${asUuid(ownerId)}
        and a."deletedAt" is null
        and a."checksumAlgorithm" = 'sha1'
      group by a.checksum, a."checksumAlgorithm"
      having count(*) > 1
      order by count(*) desc
      limit ${limit}
    `.execute(this.db);

    return rows;
  }

  async getAssistantFileTraitDuplicateCandidates(
    ownerId: string,
    limit: number,
  ): Promise<AssistantDuplicateAuditBucket[]> {
    const { rows } = await sql<AssistantDuplicateAuditBucket>`
      select
        concat_ws(
          ' | ',
          a."originalFileName",
          coalesce(ae."fileSizeInByte"::text, '?'),
          coalesce(a.width::text, '?') || 'x' || coalesce(a.height::text, '?'),
          coalesce((ae."dateTimeOriginal" at time zone 'UTC')::text, '?')
        ) as key,
        count(*)::int as "assetCount",
        null::text as "checksumAlgorithm",
        ae."fileSizeInByte"::text as "fileSizeInByte",
        a.width,
        a.height,
        (ae."dateTimeOriginal" at time zone 'UTC')::text as "dateTimeOriginal",
        array_remove((array_agg(a."originalPath" order by a."localDateTime" desc))[1:8], null) as examples
      from asset a
      left join asset_exif ae on ae."assetId" = a.id
      where a."ownerId" = ${asUuid(ownerId)}
        and a."deletedAt" is null
      group by a."originalFileName", ae."fileSizeInByte", a.width, a.height, ae."dateTimeOriginal"
      having count(*) > 1
      order by count(*) desc
      limit ${limit}
    `.execute(this.db);

    return rows;
  }

  async getAssistantVideoCohorts(ownerId: string, limit: number): Promise<AssistantVideoAuditBucket[]> {
    const { rows } = await sql<AssistantVideoAuditBucket>`
      select
        concat_ws(
          ' | ',
          coalesce(nullif(av."codecName", ''), 'Unknown codec'),
          coalesce(nullif(av."formatName", ''), 'Unknown format'),
          coalesce(nullif(av."pixelFormat", ''), 'Unknown pixel format')
        ) as key,
        count(*)::int as "assetCount",
        av."codecName",
        av."formatName",
        av."pixelFormat",
        min(a.duration) as "durationMin",
        max(a.duration) as "durationMax",
        min(av.bitrate) as "bitrateMin",
        max(av.bitrate) as "bitrateMax",
        array_remove((array_agg(a."originalPath" order by a."localDateTime" desc))[1:8], null) as examples
      from asset a
      left join asset_video av on av."assetId" = a.id
      where a."ownerId" = ${asUuid(ownerId)}
        and a."deletedAt" is null
        and a.type = 'VIDEO'
      group by av."codecName", av."formatName", av."pixelFormat"
      order by count(*) desc
      limit ${limit}
    `.execute(this.db);

    return rows;
  }

  async getAssistantMobileAppMetadataCohorts(
    ownerId: string,
    limit: number,
  ): Promise<AssistantMobileAppMetadataAuditBucket[]> {
    const { rows } = await sql<AssistantMobileAppMetadataAuditBucket>`
      select
        coalesce(am.value->>'originalUploadSource', 'mobile-app metadata without originalUploadSource') as key,
        count(*)::int as "assetCount",
        count(*) filter (where am.value->>'usedBaseOriginal' = 'true')::int as "usedBaseOriginalCount",
        count(*) filter (where am.value->>'usedFallback' = 'true')::int as "usedFallbackCount",
        count(*) filter (where am.value->>'hasAdjustments' = 'true')::int as "hasAdjustmentsCount",
        array_remove((array_agg(a."originalPath" order by a."localDateTime" desc))[1:8], null) as examples
      from asset a
      inner join asset_metadata am on am."assetId" = a.id and am.key = 'mobile-app'
      where a."ownerId" = ${asUuid(ownerId)}
        and a."deletedAt" is null
      group by coalesce(am.value->>'originalUploadSource', 'mobile-app metadata without originalUploadSource')
      order by count(*) desc
      limit ${limit}
    `.execute(this.db);

    return rows;
  }

  async getAssistantCohortAssetIds(ownerId: string, cohortType: string, cohortKey: string, limit?: number) {
    if (cohortType === 'event') {
      return this.getAssistantEventCohortAssetIds(ownerId, cohortKey, limit);
    }

    const cohortSql = this.getAssistantCohortSql(cohortType);
    if (!cohortSql) {
      return [];
    }

    const limitClause = limit === undefined ? sql`` : sql`limit ${limit}`;
    const { rows } = await sql<{ id: string }>`
      select a.id
      from asset a
      left join asset_exif ae on ae."assetId" = a.id
      where a."ownerId" = ${asUuid(ownerId)}
        and a."deletedAt" is null
        and (${sql.raw(cohortSql)}) = ${cohortKey}
      order by a."localDateTime" asc, a."originalFileName" asc
      ${limitClause}
    `.execute(this.db);

    return rows.map(({ id }) => id);
  }

  async getAssistantEventCohortAssetIds(ownerId: string, cohortKey: string, limit?: number) {
    const event = this.parseAssistantEventCohortKey(cohortKey);
    const anchorConditions = this.getAssistantEventCohortAnchorConditions(ownerId, event);
    const compatibleLocationCondition = this.getAssistantEventCompatibleLocationCondition(event);
    const limitClause = limit === undefined ? sql`` : sql`limit ${limit}`;
    const { rows } = await sql<{ id: string }>`
      with source_directories as (
        select distinct regexp_replace(a."originalPath", '/[^/]+$', '') as "sourceDirectory"
        from asset a
        left join asset_exif ae on ae."assetId" = a.id
        where ${sql.join(anchorConditions, sql` and `)}
      )
      select a.id
      from asset a
      left join asset_exif ae on ae."assetId" = a.id
      where a."ownerId" = ${asUuid(ownerId)}
        and a."deletedAt" is null
        and a."localDateTime" is not null
        and (
          (
            (a."localDateTime" at time zone 'UTC')::date >= ${event.dateStart}::date
            and (a."localDateTime" at time zone 'UTC')::date <= ${event.dateEnd}::date
            and ${compatibleLocationCondition}
          )
          or regexp_replace(a."originalPath", '/[^/]+$', '') in (select "sourceDirectory" from source_directories)
        )
      order by a."localDateTime" asc, a."originalFileName" asc
      ${limitClause}
    `.execute(this.db);

    return rows.map(({ id }) => id);
  }

  async getAssistantAuditAssets(ownerId: string, filters: AssistantAuditAssetSearch): Promise<AssistantAuditAsset[]> {
    const conditions = this.getAssistantAuditAssetConditions(ownerId, filters);
    const { rows } = await sql<AssistantAuditAsset>`
      select
        a.id,
        a.type::text as type,
        a."originalPath",
        a."originalFileName",
        encode(a.checksum, 'base64') as "storedChecksum",
        a."checksumAlgorithm"::text as "checksumAlgorithm",
        a."isExternal",
        a."isEdited",
        a."libraryId",
        ae."fileSizeInByte"::text as "fileSizeInByte",
        a.width,
        a.height,
        a.duration,
        (a."localDateTime" at time zone 'UTC')::text as "localDateTime",
        (ae."dateTimeOriginal" at time zone 'UTC')::text as "dateTimeOriginal",
        ae.make,
        ae.model,
        ae.latitude,
        ae.longitude,
        ae.city,
        ae.state,
        ae.country,
        am.value as "mobileAppMetadata"
      from asset a
      left join asset_exif ae on ae."assetId" = a.id
      left join asset_metadata am on am."assetId" = a.id and am.key = 'mobile-app'
      where ${sql.join(conditions, sql` and `)}
      order by a."localDateTime" asc, a."originalFileName" asc
    `.execute(this.db);

    return rows;
  }

  async getAssistantAuditAssetCount(ownerId: string, filters: AssistantAuditAssetSearch): Promise<number> {
    const conditions = this.getAssistantAuditAssetConditions(ownerId, filters);
    const { rows } = await sql<{ count: number }>`
      select count(*)::int as count
      from asset a
      left join asset_exif ae on ae."assetId" = a.id
      left join asset_metadata am on am."assetId" = a.id and am.key = 'mobile-app'
      where ${sql.join(conditions, sql` and `)}
    `.execute(this.db);

    return rows[0]?.count ?? 0;
  }

  async getAssistantMobileOriginalComparison(
    ownerId: string,
    desktopSourcePrefix: string,
  ): Promise<AssistantMobileOriginalComparisonBucket[]> {
    const { rows } = await sql<AssistantMobileOriginalComparisonBucket>`
      with mobile as (
        select
          a.id,
          a."originalPath",
          a."originalFileName",
          a.width,
          a.height,
          a."localDateTime",
          ae."fileSizeInByte",
          ae."dateTimeOriginal",
          ae.make,
          ae.model,
          am.value as metadata
        from asset a
        inner join asset_metadata am on am."assetId" = a.id and am.key = 'mobile-app'
        left join asset_exif ae on ae."assetId" = a.id
        where a."ownerId" = ${asUuid(ownerId)}
          and a."deletedAt" is null
      ),
      reference as (
        select
          a.id,
          a."originalPath",
          a."originalFileName",
          a.width,
          a.height,
          ae."fileSizeInByte",
          ae."dateTimeOriginal",
          ae.make,
          ae.model
        from asset a
        left join asset_exif ae on ae."assetId" = a.id
        where a."ownerId" = ${asUuid(ownerId)}
          and a."deletedAt" is null
          and a."isExternal"
          and a."originalPath" like ${`${desktopSourcePrefix}%`}
      ),
      joined as (
        select
          mobile.*,
          reference.id as "referenceId",
          reference."originalPath" as "referencePath",
          reference."fileSizeInByte" as "referenceFileSizeInByte",
          reference.width as "referenceWidth",
          reference.height as "referenceHeight",
          reference."dateTimeOriginal" as "referenceDateTimeOriginal",
          reference.make as "referenceMake",
          reference.model as "referenceModel"
        from mobile
        left join reference on lower(reference."originalFileName") = lower(mobile."originalFileName")
      )
      select
        coalesce(metadata->>'originalUploadSource', 'mobile-app metadata without originalUploadSource') as key,
        count(distinct id)::int as "mobileAssetCount",
        count(distinct "referenceId")::int as "referenceAssetCount",
        count(distinct id) filter (
          where "referenceId" is not null
            and "fileSizeInByte" is not distinct from "referenceFileSizeInByte"
            and width is not distinct from "referenceWidth"
            and height is not distinct from "referenceHeight"
            and "dateTimeOriginal" is not distinct from "referenceDateTimeOriginal"
            and make is not distinct from "referenceMake"
            and model is not distinct from "referenceModel"
        )::int as "exactTraitMatchCount",
        count(distinct id) filter (where "referenceId" is not null and "fileSizeInByte" is distinct from "referenceFileSizeInByte")::int as "sizeMismatchCount",
        count(distinct id) filter (where "referenceId" is not null and (width is distinct from "referenceWidth" or height is distinct from "referenceHeight"))::int as "dimensionsMismatchCount",
        count(distinct id) filter (where "referenceId" is not null and "dateTimeOriginal" is distinct from "referenceDateTimeOriginal")::int as "dateMismatchCount",
        count(distinct id) filter (where "referenceId" is not null and (make is distinct from "referenceMake" or model is distinct from "referenceModel"))::int as "cameraMismatchCount",
        count(distinct id) filter (where metadata->>'usedBaseOriginal' = 'true')::int as "usedBaseOriginalCount",
        count(distinct id) filter (where metadata->>'usedFallback' = 'true')::int as "usedFallbackCount",
        count(distinct id) filter (where metadata->>'hasAdjustments' = 'true')::int as "hasAdjustmentsCount",
        (array_agg(
          jsonb_build_object(
            'mobileAssetId', id,
            'mobilePath', "originalPath",
            'referencePath', "referencePath",
            'fileSizeInByte', "fileSizeInByte",
            'referenceFileSizeInByte', "referenceFileSizeInByte",
            'width', width,
            'height', height,
            'referenceWidth', "referenceWidth",
            'referenceHeight', "referenceHeight",
            'dateTimeOriginal', "dateTimeOriginal",
            'referenceDateTimeOriginal', "referenceDateTimeOriginal",
            'make', make,
            'model', model,
            'referenceMake', "referenceMake",
            'referenceModel', "referenceModel"
          )
          order by "localDateTime" desc
        ) as examples
      from joined
      group by coalesce(metadata->>'originalUploadSource', 'mobile-app metadata without originalUploadSource')
      order by count(distinct id) desc, 1 asc
    `.execute(this.db);

    return rows;
  }

  private async getAssistantAuditBuckets(
    ownerId: string,
    limit: number,
    bucketSql: string,
  ): Promise<AssistantLibraryAuditBucket[]> {
    const { rows } = await sql<AssistantLibraryAuditBucket>`
      select
        (${sql.raw(bucketSql)}) as key,
        count(*)::int as "assetCount",
        count(*) filter (where a.type = 'IMAGE')::int as "imageCount",
        count(*) filter (where a.type = 'VIDEO')::int as "videoCount",
        count(*) filter (where a."isFavorite")::int as "favoriteCount",
        count(*) filter (where a.visibility = 'archive')::int as "archivedCount",
        count(*) filter (where a."isEdited")::int as "editedCount",
        count(*) filter (where a."isExternal")::int as "externalCount",
        count(*) filter (where ae.latitude is not null and ae.longitude is not null)::int as "gpsCount",
        count(ae."assetId")::int as "exifCount",
        count(*) filter (where ae."fileSizeInByte" is not null)::int as "fileSizeCount",
        count(*) filter (where a.width is not null and a.height is not null)::int as "dimensionsCount",
        count(*) filter (where ae.make is not null or ae.model is not null)::int as "cameraCount",
        count(*) filter (where a."originalFileName" ~* '(-poster|-backdrop|-logo|-landscape|thumb|thumbnail|preview|cache|icon)')::int as "generatedLikeCount",
        count(*) filter (where a.width <= 512 and a.height <= 512)::int as "smallDimensionCount",
        count(am."assetId")::int as "mobileAppMetadataCount",
        min(a."localDateTime")::text as "dateStart",
        max(a."localDateTime")::text as "dateEnd",
        coalesce(sum(ae."fileSizeInByte"), 0)::text as "totalFileSizeBytes",
        array_remove((array_agg(a."originalPath" order by a."localDateTime" desc))[1:5], null) as examples
      from asset a
      left join asset_exif ae on ae."assetId" = a.id
      left join asset_metadata am on am."assetId" = a.id and am.key = 'mobile-app'
      where a."ownerId" = ${asUuid(ownerId)}
        and a."deletedAt" is null
      group by (${sql.raw(bucketSql)})
      order by count(*) desc, 1 asc
      limit ${limit}
    `.execute(this.db);

    return rows;
  }

  private getAssistantCohortSql(cohortType: string): string | null {
    switch (cohortType) {
      case 'source_path': {
        return this.getAssistantSourcePathCohortSql();
      }

      case 'date': {
        return this.getAssistantDateCohortSql();
      }

      case 'camera': {
        return this.getAssistantCameraCohortSql();
      }

      case 'location': {
        return this.getAssistantLocationCohortSql();
      }

      default: {
        return null;
      }
    }
  }

  private getAssistantSourcePathCohortSql() {
    return String.raw`
      regexp_replace(a."originalPath", '/[^/]+$', '')
    `;
  }

  private getAssistantDateCohortSql() {
    return `(a."localDateTime" at time zone 'UTC')::date::text`;
  }

  private getAssistantCameraCohortSql() {
    return `
      concat_ws(
        ' ',
        coalesce(nullif(ae.make, ''), 'Unknown make'),
        coalesce(nullif(ae.model, ''), 'Unknown model')
      )
    `;
  }

  private getAssistantLocationCohortSql() {
    return `
      case
        when ae.country is null and ae.state is null and ae.city is null
          and ae.latitude is not null and ae.longitude is not null then 'GPS without place labels'
        when ae.country is null and ae.state is null and ae.city is null then 'No visible location'
        else concat_ws(' / ', nullif(ae.country, ''), nullif(ae.state, ''), nullif(ae.city, ''))
      end
    `;
  }

  private getAssistantEventCohortConditions(ownerId: string, cohortKey: string): Array<RawBuilder<unknown>> {
    const event = this.parseAssistantEventCohortKey(cohortKey);
    return [
      sql`a."ownerId" = ${asUuid(ownerId)}`,
      sql`a."deletedAt" is null`,
      sql`a."localDateTime" is not null`,
      this.getAssistantEventMaterializedCondition(ownerId, event),
    ];
  }

  private getAssistantEventCohortAnchorConditions(
    ownerId: string,
    event: ReturnType<AssetRepository['parseAssistantEventCohortKey']>,
  ): Array<RawBuilder<unknown>> {
    const conditions: Array<RawBuilder<unknown>> = [
      sql`a."ownerId" = ${asUuid(ownerId)}`,
      sql`a."deletedAt" is null`,
      sql`a."localDateTime" is not null`,
      sql`(a."localDateTime" at time zone 'UTC')::date >= ${event.dateStart}::date`,
      sql`(a."localDateTime" at time zone 'UTC')::date <= ${event.dateEnd}::date`,
    ];

    if (event.country) {
      conditions.push(sql`nullif(ae.country, '') = ${event.country}`);
    }

    if (event.kind === 'place_region' || event.kind === 'place_exact') {
      if (!event.state) {
        throw new TypeError('Assistant event cohort key is missing state');
      }
      conditions.push(sql`nullif(ae.state, '') = ${event.state}`);
    }

    if (event.kind === 'place_exact') {
      if (!event.city) {
        throw new TypeError('Assistant event cohort key is missing city');
      }
      conditions.push(sql`nullif(ae.city, '') = ${event.city}`);
    }

    return conditions;
  }

  private getAssistantEventMaterializedCondition(
    ownerId: string,
    event: ReturnType<AssetRepository['parseAssistantEventCohortKey']>,
  ) {
    return sql`
      (
        (
          (a."localDateTime" at time zone 'UTC')::date >= ${event.dateStart}::date
          and (a."localDateTime" at time zone 'UTC')::date <= ${event.dateEnd}::date
          and ${this.getAssistantEventCompatibleLocationCondition(event)}
        )
        or regexp_replace(a."originalPath", '/[^/]+$', '') in (
          select distinct regexp_replace(anchor_asset."originalPath", '/[^/]+$', '')
          from asset anchor_asset
          left join asset_exif anchor_exif on anchor_exif."assetId" = anchor_asset.id
          where anchor_asset."ownerId" = ${asUuid(ownerId)}
            and anchor_asset."deletedAt" is null
            and anchor_asset."localDateTime" is not null
            and (anchor_asset."localDateTime" at time zone 'UTC')::date >= ${event.dateStart}::date
            and (anchor_asset."localDateTime" at time zone 'UTC')::date <= ${event.dateEnd}::date
            and ${this.getAssistantEventAnchorLocationCondition(event, 'anchor_exif')}
        )
      )
    `;
  }

  private getAssistantEventCompatibleLocationCondition(
    event: ReturnType<AssetRepository['parseAssistantEventCohortKey']>,
  ) {
    const noVisibleLocation = sql`nullif(ae.country, '') is null and nullif(ae.state, '') is null and nullif(ae.city, '') is null`;

    switch (event.kind) {
      case 'place_country': {
        return sql`(nullif(ae.country, '') = ${event.country} or (${noVisibleLocation}))`;
      }
      case 'place_region': {
        return sql`((nullif(ae.country, '') = ${event.country} and nullif(ae.state, '') = ${event.state}) or (${noVisibleLocation}))`;
      }
      case 'place_exact': {
        return sql`((nullif(ae.country, '') = ${event.country} and nullif(ae.state, '') is not distinct from ${event.state} and nullif(ae.city, '') = ${event.city}) or (${noVisibleLocation}))`;
      }
    }
  }

  private getAssistantEventAnchorLocationCondition(
    event: ReturnType<AssetRepository['parseAssistantEventCohortKey']>,
    exifAlias: string,
  ) {
    switch (event.kind) {
      case 'place_country': {
        return sql`nullif(${sql.ref(`${exifAlias}.country`)}, '') = ${event.country}`;
      }
      case 'place_region': {
        return sql`nullif(${sql.ref(`${exifAlias}.country`)}, '') = ${event.country} and nullif(${sql.ref(`${exifAlias}.state`)}, '') = ${event.state}`;
      }
      case 'place_exact': {
        return sql`nullif(${sql.ref(`${exifAlias}.country`)}, '') = ${event.country} and nullif(${sql.ref(`${exifAlias}.state`)}, '') is not distinct from ${event.state} and nullif(${sql.ref(`${exifAlias}.city`)}, '') = ${event.city}`;
      }
    }
  }

  private parseAssistantEventCohortKey(cohortKey: string): {
    kind: 'place_exact' | 'place_region' | 'place_country';
    country: string;
    state: string | null;
    city: string | null;
    dateStart: string;
    dateEnd: string;
  } {
    const parsed = JSON.parse(cohortKey) as Record<string, unknown>;
    const kind = parsed.kind;
    const country = parsed.country;
    const state = parsed.state;
    const city = parsed.city;
    const dateStart = parsed.dateStart;
    const dateEnd = parsed.dateEnd;

    if (kind !== 'place_exact' && kind !== 'place_region' && kind !== 'place_country') {
      throw new TypeError('Assistant event cohort key has unsupported kind');
    }

    if (typeof country !== 'string' || typeof dateStart !== 'string' || typeof dateEnd !== 'string') {
      throw new TypeError('Assistant event cohort key is missing required fields');
    }

    return {
      kind,
      country,
      state: typeof state === 'string' ? state : null,
      city: typeof city === 'string' ? city : null,
      dateStart,
      dateEnd,
    };
  }

  private getAssistantAuditAssetConditions(
    ownerId: string,
    filters: AssistantAuditAssetSearch,
  ): Array<RawBuilder<unknown>> {
    const conditions: Array<RawBuilder<unknown>> = [
      sql`a."ownerId" = ${asUuid(ownerId)}`,
      sql`a."deletedAt" is null`,
    ];

    if (filters.cohortType === 'event' && filters.cohortKey) {
      conditions.push(...this.getAssistantEventCohortConditions(ownerId, filters.cohortKey).slice(2));
    }

    const cohortSql = filters.cohortType && filters.cohortKey ? this.getAssistantCohortSql(filters.cohortType) : null;
    if (cohortSql && filters.cohortKey && filters.cohortType !== 'event') {
      conditions.push(sql`(${sql.raw(cohortSql)}) = ${filters.cohortKey}`);
    }

    if (filters.originalPathContains) {
      conditions.push(sql`a."originalPath" ilike ${`%${filters.originalPathContains}%`}`);
    }

    if (filters.originalFileNameContains) {
      conditions.push(sql`a."originalFileName" ilike ${`%${filters.originalFileNameContains}%`}`);
    }

    if (filters.fileExtension) {
      const extension = filters.fileExtension.startsWith('.') ? filters.fileExtension : `.${filters.fileExtension}`;
      conditions.push(sql`lower(a."originalFileName") like ${`%${extension.toLowerCase()}`}`);
    }

    if (filters.checksumAlgorithm) {
      conditions.push(sql`a."checksumAlgorithm" = ${filters.checksumAlgorithm}`);
    }

    if (filters.type) {
      conditions.push(sql`a.type = ${filters.type}`);
    }

    if (filters.takenAfter) {
      conditions.push(sql`a."localDateTime" >= ${filters.takenAfter}`);
    }

    if (filters.takenBefore) {
      conditions.push(sql`a."localDateTime" <= ${filters.takenBefore}`);
    }

    if (filters.make) {
      conditions.push(sql`ae.make ilike ${`%${filters.make}%`}`);
    }

    if (filters.model) {
      conditions.push(sql`ae.model ilike ${`%${filters.model}%`}`);
    }

    if (filters.country) {
      conditions.push(sql`ae.country ilike ${`%${filters.country}%`}`);
    }

    if (filters.state) {
      conditions.push(sql`ae.state ilike ${`%${filters.state}%`}`);
    }

    if (filters.city) {
      conditions.push(sql`ae.city ilike ${`%${filters.city}%`}`);
    }

    if (filters.noGps) {
      conditions.push(sql`(ae.latitude is null or ae.longitude is null)`);
    }

    if (filters.unknownCamera) {
      conditions.push(sql`(ae.make is null and ae.model is null)`);
    }

    if (filters.hasMobileMetadata !== undefined) {
      conditions.push(filters.hasMobileMetadata ? sql`am."assetId" is not null` : sql`am."assetId" is null`);
    }

    return conditions;
  }

  upsertMetadata(id: string, items: Array<{ key: string; value: Record<string, unknown> }>) {
    if (items.length === 0) {
      return [];
    }

    return this.db
      .insertInto('asset_metadata')
      .values(items.map((item) => ({ assetId: id, ...item })))
      .onConflict((oc) =>
        oc
          .columns(['assetId', 'key'])
          .doUpdateSet((eb) => ({ key: eb.ref('excluded.key'), value: eb.ref('excluded.value') })),
      )
      .returning(['key', 'value', 'updatedAt'])
      .execute();
  }

  upsertBulkMetadata(items: Insertable<AssetMetadataTable>[]) {
    return this.db
      .insertInto('asset_metadata')
      .values(items)
      .onConflict((oc) =>
        oc
          .columns(['assetId', 'key'])
          .doUpdateSet((eb) => ({ key: eb.ref('excluded.key'), value: eb.ref('excluded.value') })),
      )
      .returning(['assetId', 'key', 'value', 'updatedAt'])
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  getMetadataByKey(assetId: string, key: string) {
    return this.db
      .selectFrom('asset_metadata')
      .select(['key', 'value', 'updatedAt'])
      .where('assetId', '=', assetId)
      .where('key', '=', key)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async deleteMetadataByKey(id: string, key: string) {
    await this.db.deleteFrom('asset_metadata').where('assetId', '=', id).where('key', '=', key).execute();
  }

  @GenerateSql({ params: [[{ assetId: DummyValue.UUID, key: DummyValue.STRING }]] })
  async deleteBulkMetadata(items: Array<{ assetId: string; key: string }>) {
    if (items.length === 0) {
      return;
    }

    await this.db.transaction().execute(async (tx) => {
      for (const { assetId, key } of items) {
        await tx.deleteFrom('asset_metadata').where('assetId', '=', assetId).where('key', '=', key).execute();
      }
    });
  }

  create(asset: Insertable<AssetTable>) {
    return this.db.insertInto('asset').values(asset).returningAll().executeTakeFirstOrThrow();
  }

  @ChunkedArray({ chunkSize: 4000 })
  async createAll(assets: Insertable<AssetTable>[]) {
    const ids = await this.db.insertInto('asset').values(assets).returning('id').execute();
    return ids.map(({ id }) => id);
  }

  @GenerateSql({ params: [DummyValue.UUID, { year: 2000, day: 1, month: 1 }] })
  getByDayOfYear(ownerIds: string[], { year, day, month }: YearMonthDay) {
    return this.db
      .with('res', (qb) =>
        qb
          .with('today', (qb) =>
            qb
              .selectFrom((eb) =>
                eb
                  .fn('generate_series', [
                    sql`(select date_part('year', min(("localDateTime" at time zone 'UTC')::date))::int from asset)`,
                    sql`${year - 1}`,
                  ])
                  .as('year'),
              )
              .select((eb) => eb.fn('make_date', [sql`year::int`, sql`${month}::int`, sql`${day}::int`]).as('date')),
          )
          .selectFrom('today')
          .innerJoinLateral(
            (qb) =>
              qb
                .selectFrom('asset')
                .select(['asset.id', 'asset.localDateTime'])
                .innerJoin('asset_job_status', 'asset.id', 'asset_job_status.assetId')
                .where(sql`(asset."localDateTime" at time zone 'UTC')::date`, '=', sql`today.date`)
                .where('asset.ownerId', '=', anyUuid(ownerIds))
                .where('asset.visibility', '=', AssetVisibility.Timeline)
                .where((eb) =>
                  eb.exists((qb) =>
                    qb
                      .selectFrom('asset_file')
                      .whereRef('assetId', '=', 'asset.id')
                      .where('asset_file.type', '=', AssetFileType.Preview),
                  ),
                )
                .where('asset.deletedAt', 'is', null)
                .orderBy(sql`(asset."localDateTime" at time zone 'UTC')::date`, 'desc')
                .limit(20)
                .as('a'),
            (join) => join.onTrue(),
          )
          .selectAll('a'),
      )
      .selectFrom('res')
      .select(sql<number>`date_part('year', ("localDateTime" at time zone 'UTC')::date)::int`.as('year'))
      .select((eb) => eb.fn.jsonAgg(eb.table('res')).as('assets'))
      .groupBy(sql`("localDateTime" at time zone 'UTC')::date`)
      .orderBy(sql`("localDateTime" at time zone 'UTC')::date`, 'desc')
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @ChunkedArray()
  getByIds(ids: string[]) {
    return this.db.selectFrom('asset').selectAll('asset').where('asset.id', '=', anyUuid(ids)).execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @ChunkedArray()
  getByIdsWithAllRelationsButStacks(ids: string[]) {
    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .select(withFacesAndPeople)
      .select(withTags)
      .$call(withExif)
      .where('asset.id', '=', anyUuid(ids))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteAll(ownerId: string): Promise<void> {
    await this.db.deleteFrom('asset').where('ownerId', '=', ownerId).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  getByLibraryIdAndOriginalPath(libraryId: string, originalPath: string) {
    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .where('libraryId', '=', asUuid(libraryId))
      .where('originalPath', '=', originalPath)
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getLivePhotoCount(motionId: string): Promise<number> {
    const [{ count }] = await this.db
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('livePhotoVideoId', '=', asUuid(motionId))
      .execute();
    return count;
  }

  @GenerateSql()
  getFileSamples() {
    return this.db.selectFrom('asset_file').select(['assetId', 'path']).limit(sql.lit(3)).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForCopy(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['id', 'stackId', 'originalPath', 'isFavorite'])
      .select(withFiles)
      .where('id', '=', asUuid(id))
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getById(
    id: string,
    { exifInfo, faces, files, library, owner, smartSearch, stack, tags, edits }: GetByIdsRelations = {},
  ) {
    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .where('asset.id', '=', asUuid(id))
      .$if(!!exifInfo, withExif)
      .$if(!!faces, (qb) => qb.select(faces?.person ? withFacesAndPeople : withFaces).$narrowType<{ faces: NotNull }>())
      .$if(!!library, (qb) => qb.select(withLibrary))
      .$if(!!owner, (qb) => qb.select(withOwner))
      .$if(!!smartSearch, withSmartSearch)
      .$if(!!stack, (qb) =>
        qb
          .leftJoin('stack', 'stack.id', 'asset.stackId')
          .$if(!stack!.assets, (qb) =>
            qb.select((eb) => eb.fn.toJson(eb.table('stack')).$castTo<Stack | null>().as('stack')),
          )
          .$if(!!stack!.assets, (qb) =>
            qb
              .leftJoinLateral(
                (eb) =>
                  eb
                    .selectFrom('asset as stacked')
                    .selectAll('stack')
                    .select((eb) =>
                      eb
                        .fn<ShallowDehydrateObject<Selectable<AssetTable>>>('array_agg', [eb.table('stacked')])
                        .as('assets'),
                    )
                    .whereRef('stacked.stackId', '=', 'stack.id')
                    .whereRef('stacked.id', '!=', 'stack.primaryAssetId')
                    .where('stacked.deletedAt', 'is', null)
                    .where('stacked.visibility', '=', AssetVisibility.Timeline)
                    .groupBy('stack.id')
                    .as('stacked_assets'),
                (join) => join.on('stack.id', 'is not', null),
              )
              .select((eb) => eb.fn.toJson(eb.table('stacked_assets')).as('stack')),
          ),
      )
      .$if(!!files, (qb) => qb.select(withFiles))
      .$if(!!tags, (qb) => qb.select(withTags))
      .$if(!!edits, (qb) => qb.select(withEdits))
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [[DummyValue.UUID], {}] })
  @Chunked()
  async updateAll(ids: string[], options: Updateable<AssetTable>): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db.updateTable('asset').set(options).where('id', '=', anyUuid(ids)).execute();
  }

  async updateByLibraryId(libraryId: string, options: Updateable<AssetTable>): Promise<void> {
    await this.db.updateTable('asset').set(options).where('libraryId', '=', asUuid(libraryId)).execute();
  }

  async update(asset: Updateable<AssetTable> & { id: string }) {
    const value = omitBy(asset, isUndefined);
    delete value.id;
    if (!isEmpty(value)) {
      return this.db
        .with('asset', (qb) => qb.updateTable('asset').set(asset).where('id', '=', asUuid(asset.id)).returningAll())
        .selectFrom('asset')
        .selectAll('asset')
        .$call(withExif)
        .$call((qb) => qb.select(withFacesAndPeople))
        .$call((qb) => qb.select(withEdits))
        .executeTakeFirst();
    }

    return this.getById(asset.id, { exifInfo: true, faces: { person: true }, edits: true });
  }

  async remove(asset: { id: string }): Promise<void> {
    await this.db.deleteFrom('asset').where('id', '=', asUuid(asset.id)).execute();
  }

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, libraryId: DummyValue.UUID, checksum: DummyValue.BUFFER }] })
  getByChecksum({ ownerId, libraryId, checksum }: AssetGetByChecksumOptions) {
    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .where('ownerId', '=', asUuid(ownerId))
      .where('checksum', '=', checksum)
      .$call((qb) => (libraryId ? qb.where('libraryId', '=', asUuid(libraryId)) : qb.where('libraryId', 'is', null)))
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.BUFFER]] })
  getByChecksums(userId: string, checksums: Buffer[]) {
    return this.db
      .selectFrom('asset')
      .select(['id', 'checksum', 'deletedAt'])
      .where('ownerId', '=', asUuid(userId))
      .where('checksum', 'in', checksums)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.BUFFER] })
  async getUploadAssetIdByChecksum(ownerId: string, checksum: Buffer): Promise<string | undefined> {
    const asset = await this.db
      .selectFrom('asset')
      .select('id')
      .where('ownerId', '=', asUuid(ownerId))
      .where('checksum', '=', checksum)
      .where('libraryId', 'is', null)
      .limit(1)
      .executeTakeFirst();

    return asset?.id;
  }

  findLivePhotoMatch(options: LivePhotoSearchOptions) {
    const { ownerId, otherAssetId, livePhotoCID, type } = options;
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.ownerId'])
      .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .where('id', '!=', asUuid(otherAssetId))
      .where('ownerId', '=', asUuid(ownerId))
      .where('type', '=', type)
      .where('asset_exif.livePhotoCID', '=', livePhotoCID)
      .limit(1)
      .executeTakeFirst();
  }

  getStatistics(ownerId: string, { visibility, isFavorite, isTrashed }: AssetStatsOptions): Promise<AssetStats> {
    return this.db
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<number>().filterWhere('type', '=', AssetType.Audio).as(AssetType.Audio))
      .select((eb) => eb.fn.countAll<number>().filterWhere('type', '=', AssetType.Image).as(AssetType.Image))
      .select((eb) => eb.fn.countAll<number>().filterWhere('type', '=', AssetType.Video).as(AssetType.Video))
      .select((eb) => eb.fn.countAll<number>().filterWhere('type', '=', AssetType.Other).as(AssetType.Other))
      .where('ownerId', '=', asUuid(ownerId))
      .$if(visibility === undefined, withDefaultVisibility)
      .$if(!!visibility, (qb) => qb.where('asset.visibility', '=', visibility!))
      .$if(isFavorite !== undefined, (qb) => qb.where('isFavorite', '=', isFavorite!))
      .$if(!!isTrashed, (qb) => qb.where('asset.status', '!=', AssetStatus.Deleted))
      .where('deletedAt', isTrashed ? 'is not' : 'is', null)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({
    params: [DummyValue.UUID, { from: DummyValue.DATE, to: DummyValue.DATE, type: CalendarHeatmapType.Upload }],
  })
  getCalendarHeatmap(ownerId: string, dto: { from: Date; to: Date; type: CalendarHeatmapType }) {
    const dateColumns: Record<CalendarHeatmapType, { order: AssetOrderBy; column: 'createdAt' | 'localDateTime' }> = {
      [CalendarHeatmapType.Upload]: { order: AssetOrderBy.CreatedAt, column: 'createdAt' },
      [CalendarHeatmapType.Taken]: { order: AssetOrderBy.TakenAt, column: 'localDateTime' },
    } as const;

    const { order, column } = dateColumns[dto.type];

    const date = truncatedDate<Date>(order, 'DAY');

    return this.db
      .selectFrom('asset')
      .select(date.as('date'))
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('ownerId', '=', asUuid(ownerId))
      .where(column, '>=', dto.from)
      .where(column, '<', dto.to)
      .where('deletedAt', 'is', null)
      .groupBy(date)
      .orderBy('date', 'asc')
      .execute();
  }

  @GenerateSql({ params: [{}] })
  async getTimeBuckets(options: TimeBucketOptions): Promise<TimeBucketItem[]> {
    return this.db
      .with('asset', (qb) =>
        qb
          .selectFrom('asset')
          .select(truncatedDate<Date>(options.orderBy).as('timeBucket'))
          .$if(!!options.isTrashed, (qb) => qb.where('asset.status', '!=', AssetStatus.Deleted))
          .where('asset.deletedAt', options.isTrashed ? 'is not' : 'is', null)
          .$if(!!options.bbox, (qb) => {
            const bbox = options.bbox!;
            const circle = getBoundingCircle(bbox);

            const withBoundingCircle = qb
              .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
              .where(
                sql`earth_box(ll_to_earth_public(${circle.centerLatitude}, ${circle.centerLongitude}), ${circle.radius})`,
                '@>',
                sql`ll_to_earth_public(asset_exif.latitude, asset_exif.longitude)`,
              );

            return withBoundingBox(withBoundingCircle, bbox);
          })
          .$if(options.visibility === undefined, withDefaultVisibility)
          .$if(!!options.visibility, (qb) => qb.where('asset.visibility', '=', options.visibility!))
          .$if(!!options.albumId, (qb) =>
            qb
              .innerJoin('album_asset', 'asset.id', 'album_asset.assetId')
              .where('album_asset.albumId', '=', asUuid(options.albumId!)),
          )
          .$if(!!options.personId, (qb) => hasPeople(qb, [options.personId!]))
          .$if(!!options.withStacked, (qb) =>
            qb
              .leftJoin('stack', (join) =>
                join.onRef('stack.id', '=', 'asset.stackId').onRef('stack.primaryAssetId', '=', 'asset.id'),
              )
              .where((eb) => eb.or([eb('asset.stackId', 'is', null), eb(eb.table('stack'), 'is not', null)])),
          )
          .$if(!!options.userIds, (qb) => qb.where('asset.ownerId', '=', anyUuid(options.userIds!)))
          .$if(options.isFavorite !== undefined, (qb) => qb.where('asset.isFavorite', '=', options.isFavorite!))
          .$if(!!options.assetType, (qb) => qb.where('asset.type', '=', options.assetType!))
          .$if(options.isDuplicate !== undefined, (qb) =>
            qb.where('asset.duplicateId', options.isDuplicate ? 'is not' : 'is', null),
          )
          .$if(!!options.tagId, (qb) => withTagId(qb, options.tagId!)),
      )
      .selectFrom('asset')
      .select(sql<string>`("timeBucket" AT TIME ZONE 'UTC')::date::text`.as('timeBucket'))
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .groupBy('timeBucket')
      .orderBy('timeBucket', options.order ?? 'desc')
      .execute() as any as Promise<TimeBucketItem[]>;
  }

  @GenerateSql({
    params: [DummyValue.TIME_BUCKET, { withStacked: true }, { user: { id: DummyValue.UUID } }],
  })
  getTimeBucket(timeBucket: string, options: TimeBucketOptions, auth: AuthDto) {
    const order = options.order ?? 'desc';
    const query = this.db
      .with('cte', (qb) =>
        qb
          .selectFrom('asset')
          .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
          .select((eb) => [
            'asset.duration',
            'asset.id',
            'asset.visibility',
            sql`asset."isFavorite" and asset."ownerId" = ${auth.user.id}`.as('isFavorite'),
            sql`asset.type = 'IMAGE'`.as('isImage'),
            sql`asset."deletedAt" is not null`.as('isTrashed'),
            'asset.livePhotoVideoId',
            sql`extract(epoch from (asset."localDateTime" AT TIME ZONE 'UTC' - asset."fileCreatedAt" at time zone 'UTC'))::real / 3600`.as(
              'localOffsetHours',
            ),
            'asset.ownerId',
            'asset.status',
            sql`asset."fileCreatedAt" at time zone 'utc'`.as('fileCreatedAt'),
            sql`asset."createdAt" at time zone 'utc'`.as('createdAt'),
            eb.fn('encode', ['asset.thumbhash', sql.lit('base64')]).as('thumbhash'),
            'asset_exif.projectionType',
            eb.fn
              .coalesce(
                eb
                  .case()
                  .when(sql`asset."height" = 0 or asset."width" = 0`)
                  .then(eb.lit(1))
                  .else(sql`round(asset."width"::numeric / asset."height"::numeric, 3)`)
                  .end(),
                eb.lit(1),
              )
              .as('ratio'),
          ])
          .$if(!auth.sharedLink || auth.sharedLink.showExif, (qb) =>
            qb.select(['asset_exif.city', 'asset_exif.country']),
          )
          .$if(!!options.withCoordinates, (qb) => qb.select(['asset_exif.latitude', 'asset_exif.longitude']))
          .where('asset.deletedAt', options.isTrashed ? 'is not' : 'is', null)
          .$if(options.visibility === undefined, withDefaultVisibility)
          .$if(!!options.visibility, (qb) => qb.where('asset.visibility', '=', options.visibility!))
          .$if(!!options.bbox, (qb) => {
            const bbox = options.bbox!;
            const circle = getBoundingCircle(bbox);

            const withBoundingCircle = qb.where(
              sql`earth_box(ll_to_earth_public(${circle.centerLatitude}, ${circle.centerLongitude}), ${circle.radius})`,
              '@>',
              sql`ll_to_earth_public(asset_exif.latitude, asset_exif.longitude)`,
            );

            return withBoundingBox(withBoundingCircle, bbox);
          })
          .where(truncatedDate(options.orderBy), '=', timeBucket.replace(/^[+-]/, ''))
          .$if(!!options.albumId, (qb) =>
            qb.where((eb) =>
              eb.exists(
                eb
                  .selectFrom('album_asset')
                  .whereRef('album_asset.assetId', '=', 'asset.id')
                  .where('album_asset.albumId', '=', asUuid(options.albumId!)),
              ),
            ),
          )
          .$if(!!options.personId, (qb) => hasPeople(qb, [options.personId!]))
          .$if(!!options.userIds, (qb) => qb.where('asset.ownerId', '=', anyUuid(options.userIds!)))
          .$if(options.isFavorite !== undefined, (qb) => qb.where('asset.isFavorite', '=', options.isFavorite!))
          .$if(!!options.withStacked, (qb) =>
            qb
              .where((eb) =>
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('stack')
                      .whereRef('stack.id', '=', 'asset.stackId')
                      .whereRef('stack.primaryAssetId', '!=', 'asset.id'),
                  ),
                ),
              )
              .leftJoinLateral(
                (eb) =>
                  eb
                    .selectFrom('asset as stacked')
                    .select(sql`array[stacked."stackId"::text, count('stacked')::text]`.as('stack'))
                    .whereRef('stacked.stackId', '=', 'asset.stackId')
                    .where('stacked.deletedAt', 'is', null)
                    .where('stacked.visibility', '=', AssetVisibility.Timeline)
                    .groupBy('stacked.stackId')
                    .as('stacked_assets'),
                (join) => join.onTrue(),
              )
              .select('stack'),
          )
          .$if(!!options.assetType, (qb) => qb.where('asset.type', '=', options.assetType!))
          .$if(options.isDuplicate !== undefined, (qb) =>
            qb.where('asset.duplicateId', options.isDuplicate ? 'is not' : 'is', null),
          )
          .$if(!!options.isTrashed, (qb) => qb.where('asset.status', '!=', AssetStatus.Deleted))
          .$if(!!options.tagId, (qb) => withTagId(qb, options.tagId!))
          .orderBy(
            options.orderBy === AssetOrderBy.CreatedAt
              ? sql`"createdAt"`
              : sql`(asset."localDateTime" AT TIME ZONE 'UTC')::date`,
            order,
          )
          .orderBy('asset.fileCreatedAt', order),
      )
      .with('agg', (qb) =>
        qb
          .selectFrom('cte')
          .select((eb) => [
            eb.fn.coalesce(eb.fn('array_agg', ['duration']), sql.lit('{}')).as('duration'),
            eb.fn.coalesce(eb.fn('array_agg', ['id']), sql.lit('{}')).as('id'),
            eb.fn.coalesce(eb.fn('array_agg', ['visibility']), sql.lit('{}')).as('visibility'),
            eb.fn.coalesce(eb.fn('array_agg', ['isFavorite']), sql.lit('{}')).as('isFavorite'),
            eb.fn.coalesce(eb.fn('array_agg', ['isImage']), sql.lit('{}')).as('isImage'),
            // TODO: isTrashed is redundant as it will always be all true or false depending on the options
            eb.fn.coalesce(eb.fn('array_agg', ['isTrashed']), sql.lit('{}')).as('isTrashed'),
            eb.fn.coalesce(eb.fn('array_agg', ['livePhotoVideoId']), sql.lit('{}')).as('livePhotoVideoId'),
            eb.fn.coalesce(eb.fn('array_agg', ['fileCreatedAt']), sql.lit('{}')).as('fileCreatedAt'),
            eb.fn.coalesce(eb.fn('array_agg', ['localOffsetHours']), sql.lit('{}')).as('localOffsetHours'),
            eb.fn.coalesce(eb.fn('array_agg', ['createdAt']), sql.lit('{}')).as('createdAt'),
            eb.fn.coalesce(eb.fn('array_agg', ['ownerId']), sql.lit('{}')).as('ownerId'),
            eb.fn.coalesce(eb.fn('array_agg', ['projectionType']), sql.lit('{}')).as('projectionType'),
            eb.fn.coalesce(eb.fn('array_agg', ['ratio']), sql.lit('{}')).as('ratio'),
            eb.fn.coalesce(eb.fn('array_agg', ['status']), sql.lit('{}')).as('status'),
            eb.fn.coalesce(eb.fn('array_agg', ['thumbhash']), sql.lit('{}')).as('thumbhash'),
          ])
          .$if(!auth.sharedLink || auth.sharedLink.showExif, (qb) =>
            qb.select((eb) => [
              eb.fn.coalesce(eb.fn('array_agg', ['city']), sql.lit('{}')).as('city'),
              eb.fn.coalesce(eb.fn('array_agg', ['country']), sql.lit('{}')).as('country'),
            ]),
          )
          .$if(!!options.withCoordinates, (qb) =>
            qb.select((eb) => [
              eb.fn.coalesce(eb.fn('array_agg', ['latitude']), sql.lit('{}')).as('latitude'),
              eb.fn.coalesce(eb.fn('array_agg', ['longitude']), sql.lit('{}')).as('longitude'),
            ]),
          )
          .$if(!!options.withStacked, (qb) =>
            qb.select((eb) => eb.fn.coalesce(eb.fn('json_agg', ['stack']), sql.lit('[]')).as('stack')),
          ),
      )
      .selectFrom('agg')
      .select(sql<string>`to_json(agg)::text`.as('assets'));

    return query.executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, { minAssetsPerField: 5, maxFields: 12 }] })
  async getAssetIdByCity(ownerId: string, { minAssetsPerField, maxFields }: AssetExploreFieldOptions) {
    const items = await this.db
      .with('cities', (qb) =>
        qb
          .selectFrom('asset_exif')
          .select('city')
          .where('city', 'is not', null)
          .groupBy('city')
          .having((eb) => eb.fn('count', [eb.ref('assetId')]), '>=', minAssetsPerField),
      )
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .innerJoin('cities', 'asset_exif.city', 'cities.city')
      .distinctOn('asset_exif.city')
      .select(['assetId as data', 'asset_exif.city as value'])
      .$narrowType<{ value: NotNull }>()
      .where('ownerId', '=', asUuid(ownerId))
      .where('visibility', '=', AssetVisibility.Timeline)
      .where('type', '=', AssetType.Image)
      .where('deletedAt', 'is', null)
      .limit(maxFields)
      .execute();

    return { fieldName: 'exifInfo.city', items };
  }

  @GenerateSql({ params: [DummyValue.UUID, 12] })
  async getRecentlyCreatedAssetIds(ownerId: string, maxAssets: number) {
    const items = await this.db
      .selectFrom('asset')
      .select(['id as data', 'createdAt as value'])
      .where('ownerId', '=', asUuid(ownerId))
      .where('asset.visibility', '=', AssetVisibility.Timeline)
      .where('type', '=', AssetType.Image)
      .where('deletedAt', 'is', null)
      .orderBy('value', 'desc')
      .limit(maxAssets)
      .execute();

    return { fieldName: 'createdAt', items };
  }

  async upsertFile(
    file: Pick<
      Insertable<AssetFileTable>,
      'assetId' | 'path' | 'type' | 'isEdited' | 'isProgressive' | 'isTransparent'
    >,
  ): Promise<void> {
    await this.db
      .insertInto('asset_file')
      .values(file)
      .onConflict((oc) =>
        oc.columns(['assetId', 'type', 'isEdited']).doUpdateSet((eb) => ({
          path: eb.ref('excluded.path'),
        })),
      )
      .execute();
  }

  async upsertFiles(
    files: Pick<
      Insertable<AssetFileTable>,
      'assetId' | 'path' | 'type' | 'isEdited' | 'isProgressive' | 'isTransparent'
    >[],
  ): Promise<void> {
    if (files.length === 0) {
      return;
    }

    await this.db
      .insertInto('asset_file')
      .values(files)
      .onConflict((oc) =>
        oc.columns(['assetId', 'type', 'isEdited']).doUpdateSet((eb) => ({
          path: eb.ref('excluded.path'),
          isProgressive: eb.ref('excluded.isProgressive'),
          isTransparent: eb.ref('excluded.isTransparent'),
        })),
      )
      .execute();
  }

  async deleteFile({
    assetId,
    type,
    edited,
  }: {
    assetId: string;
    type: AssetFileType;
    edited?: boolean;
  }): Promise<void> {
    await this.db
      .deleteFrom('asset_file')
      .where('assetId', '=', asUuid(assetId))
      .where('type', '=', type)
      .$if(edited !== undefined, (qb) => qb.where('isEdited', '=', edited!))
      .execute();
  }

  async deleteFiles(files: Pick<Selectable<AssetFileTable>, 'id'>[]): Promise<void> {
    if (files.length === 0) {
      return;
    }

    await this.db
      .deleteFrom('asset_file')
      .where('id', '=', anyUuid(files.map((file) => file.id)))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.STRING], [DummyValue.STRING]] })
  async detectOfflineExternalAssets(
    libraryId: string,
    importPaths: string[],
    exclusionPatterns: string[],
  ): Promise<UpdateResult> {
    const paths = importPaths.map((importPath) => `${importPath}%`);
    const exclusions = exclusionPatterns.map((pattern) => globToSqlPattern(pattern));

    return this.db
      .updateTable('asset')
      .set({
        isOffline: true,
        deletedAt: new Date(),
      })
      .where('isOffline', '=', false)
      .where('isExternal', '=', true)
      .where('libraryId', '=', asUuid(libraryId))
      .where((eb) =>
        eb.or([
          eb.not(eb.or(paths.map((path) => eb('originalPath', 'like', path)))),
          eb.or(exclusions.map((path) => eb('originalPath', 'like', path))),
        ]),
      )
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.STRING]] })
  async filterNewExternalAssetPaths(libraryId: string, paths: string[]): Promise<string[]> {
    const result = await this.db
      .selectFrom(unnest(paths).as('path'))
      .select('path')
      .where((eb) =>
        eb.not(
          eb.exists(
            this.db
              .selectFrom('asset')
              .select('originalPath')
              .whereRef('asset.originalPath', '=', eb.ref('path'))
              .where('libraryId', '=', asUuid(libraryId))
              .where('isExternal', '=', true),
          ),
        ),
      )
      .execute();

    return result.map((row) => row.path as string);
  }

  async getLibraryAssetCount(libraryId: string): Promise<number> {
    const { count } = await this.db
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('libraryId', '=', asUuid(libraryId))
      .executeTakeFirstOrThrow();

    return count;
  }

  private buildGetForOriginal(ids: string[], isEdited: boolean) {
    return this.db
      .selectFrom('asset')
      .select('asset.id')
      .select('originalFileName')
      .where('asset.id', 'in', ids)
      .$if(isEdited, (qb) =>
        qb
          .leftJoin('asset_file', (join) =>
            join
              .onRef('asset.id', '=', 'asset_file.assetId')
              .on('asset_file.isEdited', '=', true)
              .on('asset_file.type', '=', AssetFileType.FullSize),
          )
          .select('asset_file.path as editedPath'),
      )
      .select('originalPath');
  }

  @GenerateSql({ params: [DummyValue.UUID, true] })
  getForOriginal(id: string, isEdited: boolean) {
    return this.buildGetForOriginal([id], isEdited).executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [[DummyValue.UUID], true] })
  getForOriginals(ids: string[], isEdited: boolean) {
    return this.buildGetForOriginal(ids, isEdited).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, AssetFileType.Preview, true] })
  async getForThumbnail(id: string, type: AssetFileType, isEdited: boolean) {
    return this.db
      .selectFrom('asset')
      .where('asset.id', '=', id)
      .leftJoin('asset_file', (join) =>
        join.onRef('asset.id', '=', 'asset_file.assetId').on('asset_file.type', '=', type),
      )
      .select(['asset.originalPath', 'asset.originalFileName', 'asset_file.path as path'])
      .orderBy('asset_file.isEdited', isEdited ? 'desc' : 'asc')
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForVideo(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.originalPath'])
      .select((eb) => withFilePath(eb, AssetFileType.EncodedVideo).as('encodedVideoPath'))
      .where('asset.id', '=', id)
      .where('asset.type', '=', AssetType.Video)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForOcr(id: string) {
    return this.db
      .selectFrom('asset')
      .where('asset.id', '=', id)
      .select(withEdits)
      .innerJoin('asset_exif', (join) => join.onRef('asset_exif.assetId', '=', 'asset.id'))
      .select(['asset_exif.exifImageWidth', 'asset_exif.exifImageHeight', 'asset_exif.orientation'])
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForEdit(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.type', 'asset.livePhotoVideoId', 'asset.originalPath', 'asset.originalFileName'])
      .where('asset.id', '=', id)
      .innerJoin('asset_exif', (join) => join.onRef('asset_exif.assetId', '=', 'asset.id'))
      .select([
        'asset_exif.exifImageWidth',
        'asset_exif.exifImageHeight',
        'asset_exif.orientation',
        'asset_exif.projectionType',
      ])
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForMetadataExtractionTags(id: string) {
    return this.db
      .selectFrom('asset_exif')
      .select('asset_exif.tags')
      .where('asset_exif.assetId', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForFaces(id: string) {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', (join) => join.onRef('asset_exif.assetId', '=', 'asset.id'))
      .select(['asset_exif.exifImageHeight', 'asset_exif.exifImageWidth', 'asset_exif.orientation'])
      .select(withEdits)
      .where('asset.id', '=', id)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForUpdateTags(id: string) {
    return this.db
      .selectFrom('asset')
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('tag')
            .select('tag.value')
            .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
            .whereRef('asset.id', '=', 'tag_asset.assetId'),
        ).as('tags'),
      )
      .where('asset.id', '=', id)
      .executeTakeFirstOrThrow();
  }
}
