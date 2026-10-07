import type { AssetResponseDto } from '@immich/sdk';
import {
  mdiBrightness6,
  mdiCalendar,
  mdiCamera,
  mdiCameraIris,
  mdiCameraOutline,
  mdiClockEditOutline,
  mdiCrosshairsGps,
  mdiEarth,
  mdiFileClockOutline,
  mdiFileEditOutline,
  mdiFileImageOutline,
  mdiFitToScreen,
  mdiFolderOutline,
  mdiMapMarkerOutline,
  mdiPanorama,
  mdiPhoneRotateLandscape,
  mdiRayStartArrow,
  mdiStarOutline,
  mdiTextBox,
  mdiTimerOutline,
  mdiWeightKilogram,
} from '@mdi/js';
import { DateTime } from 'luxon';
import type { MessageFormatter } from 'svelte-i18n';
import { getAssetResolution, getFileSize } from '$lib/utils/asset-utils';
import { fromISODateTime, fromISODateTimeUTC } from '$lib/utils/timeline-util';

const truncateMiddle = (path: string, maxLength = 50): string => {
  if (path.length <= maxLength) {
    return path;
  }

  const lastSlash = path.lastIndexOf('/');
  const tail = lastSlash === -1 ? path : path.slice(lastSlash);

  if (tail.length >= maxLength - 3) {
    const half = Math.floor((maxLength - 3) / 2);
    return path.slice(0, half) + '...' + path.slice(-half);
  }

  const headLength = maxLength - 3 - tail.length;
  return path.slice(0, headLength) + '...' + tail;
};

const formatISODateToLocale = (iso: string, locale: string | undefined): string =>
  fromISODateTimeUTC(iso).toLocaleString({ month: 'short', day: 'numeric', year: 'numeric' }, { locale });

const getDateTime = (asset: AssetResponseDto) => {
  const timeZone = asset.exifInfo?.timeZone;
  return timeZone && asset.exifInfo?.dateTimeOriginal
    ? fromISODateTime(asset.exifInfo.dateTimeOriginal, timeZone)
    : fromISODateTimeUTC(asset.localDateTime);
};

type MetadataFieldDefinition = {
  icon: string;
  titleKey: string;
  keys: readonly string[];
  render: (asset: AssetResponseDto, $t: MessageFormatter, locale: string | undefined) => string;
  tooltip?: (asset: AssetResponseDto, $t: MessageFormatter) => string;
};

const metadataFields = [
  {
    icon: mdiFileImageOutline,
    titleKey: 'file_name_text',
    keys: ['originalFileName'],
    render: (asset, $t) => asset.originalFileName || $t('unknown'),
  },
  {
    icon: mdiFolderOutline,
    titleKey: 'path',
    keys: ['originalPath'],
    render: (asset, $t) => asset.originalPath || $t('unknown'),
    tooltip: (asset, $t) => $t('full_path', { values: { path: asset.originalPath } }),
  },
  {
    icon: mdiWeightKilogram,
    titleKey: 'file_size',
    keys: ['fileSize'],
    render: (asset) => getFileSize(asset),
  },
  {
    icon: mdiFitToScreen,
    titleKey: 'resolution',
    keys: ['resolution'],
    render: (asset, $t) => getAssetResolution(asset) || $t('unknown'),
  },
  {
    icon: mdiFileClockOutline,
    titleKey: 'created_at',
    keys: ['fileCreatedAt'],
    render: (asset, _t, locale) => formatISODateToLocale(asset.fileCreatedAt, locale),
  },
  {
    icon: mdiFileEditOutline,
    titleKey: 'updated_at',
    keys: ['fileModifiedAt'],
    render: (asset, _t, locale) => formatISODateToLocale(asset.fileModifiedAt, locale),
  },
  {
    icon: mdiCalendar,
    titleKey: 'date_time_original',
    keys: ['dateTimeOriginal'],
    render: (asset, $t, locale) => {
      const dateTime = getDateTime(asset);
      return dateTime
        ? dateTime.toLocaleString(
            {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              second: '2-digit',
              timeZoneName: 'shortOffset',
            },
            { locale },
          )
        : $t('unknown');
    },
  },
  {
    icon: mdiEarth,
    titleKey: 'timezone',
    keys: ['timeZone'],
    render: (asset, $t) => getDateTime(asset)?.offsetNameShort ?? $t('unknown'),
  },
  {
    icon: mdiClockEditOutline,
    titleKey: 'modify_date',
    keys: ['modifyDate'],
    render: (asset, $t, locale) =>
      asset.exifInfo?.modifyDate ? formatISODateToLocale(asset.exifInfo.modifyDate, locale) : $t('unknown'),
  },
  {
    icon: mdiMapMarkerOutline,
    titleKey: 'location',
    keys: ['city', 'state', 'country'],
    render: (asset, $t) => {
      const parts = [asset.exifInfo?.city, asset.exifInfo?.state, asset.exifInfo?.country].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : $t('unknown');
    },
  },
  {
    icon: mdiCrosshairsGps,
    titleKey: 'gps',
    keys: ['latitude', 'longitude'],
    render: (asset, $t) =>
      // eslint-disable-next-line eqeqeq
      asset.exifInfo?.latitude != null && asset.exifInfo?.longitude != null
        ? `${asset.exifInfo.latitude.toFixed(4)}, ${asset.exifInfo.longitude.toFixed(4)}`
        : $t('unknown'),
  },
  {
    icon: mdiCameraOutline,
    titleKey: 'make',
    keys: ['make'],
    render: (asset, $t) => asset.exifInfo?.make || $t('unknown'),
  },
  {
    icon: mdiCamera,
    titleKey: 'model',
    keys: ['model'],
    render: (asset, $t) => asset.exifInfo?.model || $t('unknown'),
  },
  {
    icon: mdiCameraIris,
    titleKey: 'lens_model',
    keys: ['lensModel'],
    render: (asset, $t) => asset.exifInfo?.lensModel || $t('unknown'),
  },
  {
    icon: mdiCameraIris,
    titleKey: 'f_number',
    keys: ['fNumber'],
    // eslint-disable-next-line eqeqeq
    render: (asset, $t) => (asset.exifInfo?.fNumber == null ? $t('unknown') : `f/${asset.exifInfo.fNumber.toFixed(1)}`),
  },
  {
    icon: mdiRayStartArrow,
    titleKey: 'focal_length',
    keys: ['focalLength'],
    // eslint-disable-next-line eqeqeq
    render: (asset, $t) => (asset.exifInfo?.focalLength == null ? $t('unknown') : `${asset.exifInfo.focalLength} mm`),
  },
  {
    icon: mdiBrightness6,
    titleKey: 'iso',
    keys: ['iso'],
    // eslint-disable-next-line eqeqeq
    render: (asset, $t) => (asset.exifInfo?.iso == null ? $t('unknown') : `ISO ${asset.exifInfo.iso}`),
  },
  {
    icon: mdiTimerOutline,
    titleKey: 'exposure_time',
    keys: ['exposureTime'],
    render: (asset, $t) => asset.exifInfo?.exposureTime || $t('unknown'),
  },
  {
    icon: mdiTextBox,
    titleKey: 'description',
    keys: ['description'],
    render: (asset, $t) => asset.exifInfo?.description || $t('unknown'),
  },
  {
    icon: mdiStarOutline,
    titleKey: 'rating',
    keys: ['rating'],
    // eslint-disable-next-line eqeqeq
    render: (asset, $t) => (asset.exifInfo?.rating == null ? $t('unknown') : `${asset.exifInfo.rating} stars`),
  },
  {
    icon: mdiPhoneRotateLandscape,
    titleKey: 'orientation',
    keys: ['orientation'],
    render: (asset, $t) => asset.exifInfo?.orientation || $t('unknown'),
  },
  {
    icon: mdiPanorama,
    titleKey: 'projection_type',
    keys: ['projectionType'],
    render: (asset, $t) => asset.exifInfo?.projectionType || $t('unknown'),
  },
] as const satisfies readonly MetadataFieldDefinition[];

export type MetadataFieldKey = (typeof metadataFields)[number]['keys'][number];
export type DifferingMetadataFields = Partial<Record<MetadataFieldKey, boolean>>;

export const metadataKeys: readonly MetadataFieldKey[] = metadataFields.flatMap(({ keys }) => keys);

export const countDifferingMetadataItems = (differing: DifferingMetadataFields): number =>
  metadataFields.filter(({ keys }) => keys.some((k) => differing[k as MetadataFieldKey])).length;

export const getAllMetadataItems = (asset: AssetResponseDto, $t: MessageFormatter, locale: string | undefined) =>
  metadataFields.map((field) => ({
    icon: field.icon,
    title: $t(field.titleKey),
    render: field.render(asset, $t, locale),
    tooltip: 'tooltip' in field ? field.tooltip(asset, $t) : undefined,
    keys: field.keys,
  }));

const normalizeForComparison = (key: MetadataFieldKey, value: unknown): unknown => {
  if (value === null || value === undefined) {
    return value;
  }

  if (['fileCreatedAt', 'fileModifiedAt', 'dateTimeOriginal', 'modifyDate'].includes(key)) {
    const dateTime = DateTime.fromISO(String(value));
    return dateTime.isValid ? dateTime.toISO() : String(value);
  }

  if (key === 'fNumber' && typeof value === 'number') {
    return Number(value.toFixed(1));
  }
  if ((key === 'latitude' || key === 'longitude') && typeof value === 'number') {
    return Number(value.toFixed(4));
  }
  if (key === 'focalLength' && typeof value === 'number') {
    return Number(value.toFixed(2));
  }

  return value;
};

const getValueForAsset = (asset: AssetResponseDto, key: MetadataFieldKey): unknown => {
  switch (key) {
    case 'fileCreatedAt':
    case 'fileModifiedAt':
    case 'originalFileName':
    case 'originalPath': {
      return asset[key];
    }
    case 'fileSize': {
      return getFileSize(asset);
    }
    case 'resolution': {
      return getAssetResolution(asset);
    }
    default: {
      if (asset.exifInfo && Object.hasOwn(asset.exifInfo, key)) {
        return asset.exifInfo[key as keyof typeof asset.exifInfo];
      }
      return undefined;
    }
  }
};

export const computeDifferingMetadataFields = (assets: AssetResponseDto[]): DifferingMetadataFields => {
  const diffs: DifferingMetadataFields = {};

  for (const key of metadataKeys) {
    const uniqueValues = new Set<unknown>();

    for (const asset of assets) {
      const value = getValueForAsset(asset, key);
      if (value !== undefined && value !== null) {
        uniqueValues.add(normalizeForComparison(key, value));
      }
    }

    diffs[key] = uniqueValues.size > 1;
  }

  return diffs;
};

const GENERIC_SEGMENT_REGEX =
  /^(mnt|volume\d+(_\w+)?|photosync|docker|upload[s]?|usr|app|var|data|home|users|originals(_clean)?|uploads_macbookpro|uploads_immich|master photo library|mainphoto|laptop backup|photos|dcim|\d{3}[a-z0-9_]+|camera(_roll)?|sdcard|internal_storage|_?no[ _]?date|apple_derivatives|_app_assets|photo exif unknown|moved.*|.*mistaken duplicate.*|\d{4}|\d{2}|\d{4}[-_.]\d{2}([-_.]\d{2})?|\d{8}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december))$/i;

export interface FolderOrganizationScore {
  descriptiveSegmentsCount: number;
  depth: number;
  descriptiveLength: number;
}

export const getFolderOrganizationScore = (filePath?: string): FolderOrganizationScore => {
  if (!filePath) {
    return { descriptiveSegmentsCount: 0, depth: 0, descriptiveLength: 0 };
  }

  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const dirPath = lastSlash === -1 ? '' : normalized.slice(0, lastSlash);
  if (!dirPath) {
    return { descriptiveSegmentsCount: 0, depth: 0, descriptiveLength: 0 };
  }

  const segments = dirPath.split('/').filter(Boolean);
  let descriptiveCount = 0;
  let descriptiveLength = 0;

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!GENERIC_SEGMENT_REGEX.test(trimmed)) {
      const letters = trimmed.match(/[a-zA-Z]/g);
      if (letters && letters.length >= 2) {
        descriptiveCount++;
        descriptiveLength += trimmed.length;
      }
    }
  }

  return {
    descriptiveSegmentsCount: descriptiveCount,
    depth: segments.length,
    descriptiveLength,
  };
};

export interface CopyBetterToHoldingResult {
  totalFound: number;
  copied: number;
  alreadyExisted: number;
  failed: number;
  errors: string[];
}

export const copyBetterToHolding = async (duplicateIds?: string[]): Promise<CopyBetterToHoldingResult> => {
  const res = await fetch('/api/duplicates/copy-better-to-holding', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ duplicateIds: duplicateIds ?? [] }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(errorText || `Failed to copy better copies to holding (${res.status})`);
  }

  return res.json();
};

export const parseDateFromFilename = (fileName?: string | null): Date | null => {
  if (!fileName) {
    return null;
  }

  // 1. Dash/underscore/dot separated YYYY-MM-DD with optional time
  const matchDelimited = fileName.match(
    /(?:^|[^0-9a-zA-Z])(19[7-9]\d|20[0-3]\d)[-_.](0[1-9]|1[0-2])[-_.](0[1-9]|[12]\d|3[01])(?:(?:[ _T-]+|\s+at\s+)(0\d|1\d|2[0-3]|[0-9])[-_.:](0\d|[0-5]\d)(?:[-_.:](0\d|[0-5]\d))?(?:\s*(AM|PM))?)?(?:[^0-9a-zA-Z]|$)/i,
  );
  if (matchDelimited) {
    const [, yr, mo, dy, hrStr, minStr, secStr, ampm] = matchDelimited;
    let hr = hrStr ? +hrStr : 0;
    const min = minStr ? +minStr : 0;
    const sec = secStr ? +secStr : 0;
    if (ampm) {
      if (ampm.toUpperCase() === 'PM' && hr < 12) {
        hr += 12;
      }
      if (ampm.toUpperCase() === 'AM' && hr === 12) {
        hr = 0;
      }
    }
    const d = new Date(Date.UTC(+yr, +mo - 1, +dy, hr, min, sec));
    if (!isNaN(d.getTime())) {
      return d;
    }
  }

  // 2. Compact YYYYMMDD with optional HHMMSS
  const matchCompact = fileName.match(
    /(?:^|[^0-9])(19[7-9]\d|20[0-3]\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[-_ ]?(0\d|1\d|2[0-3])([0-5]\d)([0-5]\d)?)?(?:[^0-9]|$)/,
  );
  if (matchCompact) {
    const [, yr, mo, dy, hr, min, sec] = matchCompact;
    const d = new Date(Date.UTC(+yr, +mo - 1, +dy, +(hr ?? 0), +(min ?? 0), +(sec ?? 0)));
    if (!isNaN(d.getTime())) {
      return d;
    }
  }

  return null;
};

export const getFilenameDateString = (fileName?: string | null): string | null => {
  const d = parseDateFromFilename(fileName);
  if (!d) return null;
  return d.toISOString().slice(0, 10);
};

