import { AssetResponseDto } from 'src/dtos/asset-response.dto.js';
import { AssetType } from 'src/enum.js';
import {
  durationsMatch,
  frameRatesMatch,
  getHammingDistance,
  HIGH_CONFIDENCE_MAX_DISTANCE,
  isSiblingProtected,
  MAX_ASPECT_RATIO_DIFFERENCE,
  MIN_DIMENSION_RATIO,
  POSSIBLE_MAX_DISTANCE,
} from 'src/utils/fingerprint.js';

/**
 * Counts all truthy values in the exifInfo object.
 * This matches the client implementation in web/src/lib/utils/exif-utils.ts
 *
 * @param asset Asset with optional exifInfo
 * @returns Count of truthy EXIF values
 */
export const getExifCount = (asset: AssetResponseDto): number => {
  return Object.values(asset.exifInfo ?? {}).filter(Boolean).length;
};

/**
 * How much evidence there is that the members of a duplicate group are the same picture.
 *
 * Mirrors the classifications in `docs/duplicate-detection.md` from the immich-go staged uploader
 * (2026-09-09). Immich's duplicate groups come from CLIP embedding distance, which is similarity,
 * not identity; everything above Possible is earned from the content fingerprints computed by
 * `FingerprintService` and stored in `asset_fingerprint`.
 */
export enum DuplicateClassification {
  /** Every member shares the same SHA-1. The same bytes. */
  Exact = 'EXACT',
  /**
   * Two members decode to identical full-resolution, orientation-normalized pixels. Different
   * containers or metadata, the same picture -- a Google Takeout re-encode of an original lands
   * here. Resolvable unattended, like Exact.
   */
  ContentIdentical = 'CONTENT_IDENTICAL',
  /**
   * Perceptual hashes within {@link HIGH_CONFIDENCE_MAX_DISTANCE} of each other, with matching
   * aspect ratio, comparable dimensions, agreeing motion-photo state, and no burst/edit marker on
   * either side.
   */
  HighConfidence = 'HIGH_CONFIDENCE_DUPLICATE',
  /** Fingerprinted, but the evidence does not support calling them the same picture. */
  Possible = 'POSSIBLE_DUPLICATE',
  /**
   * Not yet fingerprinted. Distinct from Possible on purpose: "we have not looked" and "we looked
   * and it is not convincing" are different answers, and collapsing them tells the user 50,000
   * groups need their eyes when most are simply still queued.
   */
  Unanalyzed = 'UNANALYZED',
}

const AUTO_RESOLVE_LEVELS: Record<DuplicateAutoResolve, DuplicateClassification[]> = {
  exact: [DuplicateClassification.Exact],
  content: [DuplicateClassification.Exact, DuplicateClassification.ContentIdentical],
  near: [
    DuplicateClassification.Exact,
    DuplicateClassification.ContentIdentical,
    DuplicateClassification.HighConfidence,
  ],
};

export type DuplicateAutoResolve = 'exact' | 'content' | 'near';

/** The classifications the server may act on without a human looking at the group. */
export const getAutoResolvable = (level: DuplicateAutoResolve): ReadonlySet<DuplicateClassification> =>
  new Set(AUTO_RESOLVE_LEVELS[level] ?? AUTO_RESOLVE_LEVELS.content);

/** Evidence strong enough to delete without a person reviewing that specific group. */
export const SAFE_AUTO_RESOLVABLE: ReadonlySet<DuplicateClassification> = new Set([
  DuplicateClassification.Exact,
  DuplicateClassification.ContentIdentical,
]);

/**
 * Tunables for the keep suggestion, from `machineLearning.duplicateDetection.keepPreference`, so
 * the path vocabulary of a particular library is configuration rather than a literal in this file.
 */
export interface DuplicateKeepPreference {
  enabled: boolean;
  /** Regexes matched against a single path segment. A hit marks the asset as curated/organized. */
  preferredPathPatterns: string[];
  /** Regexes matched against a single path segment. A hit marks the asset as import/staging scratch. */
  stagingPathPatterns: string[];
  /** Regexes matched against a single path segment. A hit marks the asset as originals library. */
  originalsPathPatterns?: string[];
  /** Regexes matched against a single path segment. A hit marks the asset as MacBook Pro uploads. */
  macbookProPathPatterns?: string[];
  /** Keeper-score advantage required to prefer one copy over another (immich-go uses 1). */
  scoreMargin: number;
  /** File sizes within this fraction of each other are treated as equal. */
  sizeTolerance: number;
}

export const enum PathTier {
  Staging = 0,
  Neutral = 1,
  Curated = 2,
  UploadsMacbookPro = 3,
  Originals = 4,
}

/** Accepts both the API shape (base64 string) and the database shape (Buffer). */
const checksumKey = (checksum: string | Buffer): string =>
  typeof checksum === 'string' ? checksum : checksum.toString('base64');

export interface ClassifiableAsset {
  id: string;
  checksum: string | Buffer;
  originalFileName: string;
  isEdited: boolean;
  /** Video duration in milliseconds; null for stills. */
  duration?: number | null;
  localDateTime?: string | Date | null;
  exifInfo?: { dateTimeOriginal?: string | Date | null; fps?: number | null } | null;
}

/**
 * How strong the evidence is that the members of a duplicate group are the same picture.
 *
 * Escalates only as far as the evidence allows, and stops at Possible whenever fingerprints are
 * missing, errored, or flagged uninformative -- an absent fingerprint means "not yet proven", never
 * "proven different".
 */
export const classifyDuplicateGroup = (
  assets: ClassifiableAsset[],
  fingerprints?: Map<string, AssetFingerprintEvidence>,
): DuplicateClassification => {
  const checksums = new Set(assets.map(({ checksum }) => checksumKey(checksum)));
  if (checksums.size === 1) {
    return DuplicateClassification.Exact;
  }

  if (!fingerprints || assets.some(({ id }) => !fingerprints.get(id))) {
    return DuplicateClassification.Unanalyzed;
  }

  let best = DuplicateClassification.ContentIdentical;
  for (let i = 0; i < assets.length; i++) {
    for (let j = i + 1; j < assets.length; j++) {
      const pair = comparePair(assets[i], assets[j], fingerprints);
      if (pair === DuplicateClassification.Possible) return DuplicateClassification.Possible;
      if (pair === DuplicateClassification.HighConfidence) {
        best = DuplicateClassification.HighConfidence;
      }
    }
  }
  return best;
};

export interface AssetFingerprintEvidence {
  contentHash: Buffer | null;
  /** Videos only: hash over pixel digests of frames sampled across the duration. */
  frameHash: Buffer | null;
  perceptualHash: Buffer | null;
  width: number | null;
  height: number | null;
  informative: boolean;
  hasEmbeddedMedia: boolean;
  error: string | null;
}

/**
 * Pairwise verification. Candidates are never merged by transitive similarity -- two assets that
 * each resemble a third are not thereby duplicates of each other.
 */
const comparePair = (
  a: ClassifiableAsset,
  b: ClassifiableAsset,
  fingerprints: Map<string, AssetFingerprintEvidence>,
): DuplicateClassification => {
  const fa = fingerprints.get(a.id);
  const fb = fingerprints.get(b.id);
  if (!fa || !fb || fa.error || fb.error) {
    return DuplicateClassification.Possible;
  }

  // A file carrying a trailing motion-photo payload is not the same file as one without it, however
  // identical the still pixels are. Google Takeout strips exactly this.
  const motionMatches = fa.hasEmbeddedMedia === fb.hasEmbeddedMedia;

  if (
    motionMatches &&
    fa.contentHash &&
    fb.contentHash &&
    fa.contentHash.equals(fb.contentHash) &&
    ((fa.width === fb.width && fa.height === fb.height) ||
      (fa.width === null && fa.height === null && fb.width === null && fb.height === null))
  ) {
    return DuplicateClassification.ContentIdentical;
  }

  // Videos: five frames sampled across the duration agreeing exactly, with geometry, duration and
  // frame rate to match. Strong, but sampling cannot speak for audio, subtitles or the frames in
  // between, so this stops at HIGH_CONFIDENCE rather than claiming identity of the whole file.
  if (
    motionMatches &&
    fa.frameHash &&
    fb.frameHash &&
    fa.frameHash.equals(fb.frameHash) &&
    fa.informative &&
    fb.informative &&
    fa.width === fb.width &&
    fa.height === fb.height &&
    durationsMatch(a.duration ?? 0, b.duration ?? 0) &&
    frameRatesMatch(a.exifInfo?.fps ?? null, b.exifInfo?.fps ?? null) &&
    !isSiblingProtected({ fileName: a.originalFileName, isEdited: a.isEdited }) &&
    !isSiblingProtected({ fileName: b.originalFileName, isEdited: b.isEdited })
  ) {
    return DuplicateClassification.HighConfidence;
  }

  if (!fa.perceptualHash || !fb.perceptualHash || !fa.informative || !fb.informative) {
    return DuplicateClassification.Possible;
  }

  if (!fa.width || !fa.height || !fb.width || !fb.height) {
    return DuplicateClassification.Possible;
  }

  const ratioA = fa.width / fa.height;
  const ratioB = fb.width / fb.height;
  if (Math.abs(ratioA / ratioB - 1) > MAX_ASPECT_RATIO_DIFFERENCE) {
    return DuplicateClassification.Possible;
  }

  const distance = getHammingDistance(fa.perceptualHash, fb.perceptualHash);
  if (distance > POSSIBLE_MAX_DISTANCE) {
    return DuplicateClassification.Possible;
  }

  if (distance > HIGH_CONFIDENCE_MAX_DISTANCE) {
    return DuplicateClassification.Possible;
  }

  // Burst frames and explicit edits look almost identical but are different pictures.
  if (
    isSiblingProtected({ fileName: a.originalFileName, isEdited: a.isEdited }) ||
    isSiblingProtected({ fileName: b.originalFileName, isEdited: b.isEdited })
  ) {
    return DuplicateClassification.Possible;
  }

  // immich-go additionally requires capture times within two seconds. That rule is not carried over
  // here, and the reason is measured rather than assumed: on this library 147 of 183 near-hash
  // pairs failed it, and 145 of those differ by more than a DAY -- up to 16 years. These are Google
  // Takeout re-exports and scanned prints whose dates were assigned independently of the original.
  // The rule makes sense for an uploader comparing a local file against the server copy it just
  // sent, where the timestamps share an origin; for a library it rejects almost every true match.
  // What it was protecting against -- burst siblings seconds apart -- is covered by the explicit
  // burst/edit guard above, which is the check that actually targets that case.

  const widthRatio = Math.min(fa.width, fb.width) / Math.max(fa.width, fb.width);
  const heightRatio = Math.min(fa.height, fb.height) / Math.max(fa.height, fb.height);
  if (widthRatio < MIN_DIMENSION_RATIO || heightRatio < MIN_DIMENSION_RATIO) {
    // Exact perceptual match (distance <= 2) with matching aspect ratio is an undeniable thumbnail/preview copy.
    if (distance <= 2) {
      return DuplicateClassification.HighConfidence;
    }
    return DuplicateClassification.Possible;
  }

  return DuplicateClassification.HighConfidence;
};

const RAW_EXTENSIONS = new Set([
  '3fr',
  'ari',
  'arw',
  'cap',
  'cin',
  'cr2',
  'cr3',
  'crw',
  'dcr',
  'dng',
  'erf',
  'fff',
  'iiq',
  'k25',
  'kdc',
  'mrw',
  'nef',
  'nrw',
  'orf',
  'ori',
  'pef',
  'psd',
  'raf',
  'raw',
  'rw2',
  'rwl',
  'sr2',
  'srf',
  'srw',
  'x3f',
]);

const getExtension = (asset: AssetResponseDto): string =>
  asset.originalFileName.slice(asset.originalFileName.lastIndexOf('.') + 1).toLowerCase();

/** Explicit burst/edit markers. Ported from `internal/duplicates/model.go`. */
const EDITED_MARKER = /(^|[\s_().-])(edited|edit|cropped|filtered)([\s_().-]|$)/i;
const BURST_MARKER = /(^|[\s_().-])burst([\s_().-]|$)/i;

const isProtected = (asset: AssetResponseDto): boolean =>
  asset.isEdited || EDITED_MARKER.test(asset.originalFileName) || BURST_MARKER.test(asset.originalFileName);

const countMetadata = (asset: AssetResponseDto, albumCount: number): number => {
  const exif = asset.exifInfo;
  let count = 0;
  if (exif?.dateTimeOriginal) {
    count++;
  }
  if (exif?.description) {
    count++;
  }
  // eslint-disable-next-line eqeqeq
  if (exif?.latitude != null && exif?.longitude != null) {
    count++;
  }
  if (exif?.rating) {
    count++;
  }
  if (asset.tags && asset.tags.length > 0) {
    count++;
  }
  if (albumCount > 0) {
    count++;
  }
  return count;
};

/**
 * Keeper score, ported from `Quality()` in immich-go `internal/duplicates/model.go` (2026-09-09).
 *
 * `20 * log2(1 + megapixels)`, plus RAW +40, PNG/TIFF +8 or HEIC/AVIF +4, video bitrate (max +12),
 * and metadata completeness (max +6); explicit burst/edit markers take a 2 point preference
 * penalty. As in the original, **file size is not an input** -- it measures compression, not
 * information.
 *
 * Terms that could NOT be ported, because they need the file bytes that immich-go downloads and
 * this endpoint does not have. Anything relying on these is weaker here than in the uploader:
 *  - HDR (+12): not recorded anywhere in asset_exif.
 *  - Bit depth (+2/bit above 8, max +16): asset_exif stores bitsPerSample but AssetResponseDto
 *    does not expose it; expose it there if this term is wanted.
 *  - Codec efficiency (hevc/av1 x1.5, vp9 x1.3): codec is not recorded, so bitrate is unadjusted.
 *  - Video bitrate is derived from file size over duration here, not read from FFprobe.
 *  - RAW and format are inferred from the file extension rather than from decoding the file.
 */
export const getKeeperScore = (asset: AssetResponseDto, albumCount = 0): number => {
  const width = asset.width ?? asset.exifInfo?.exifImageWidth ?? 0;
  const height = asset.height ?? asset.exifInfo?.exifImageHeight ?? 0;
  let score = 20 * Math.log2(1 + (width * height) / 1e6);

  const extension = getExtension(asset);
  if (RAW_EXTENSIONS.has(extension)) {
    score += 40;
  }

  switch (extension) {
    case 'png':
    case 'tif':
    case 'tiff': {
      score += 8;
      break;
    }
    case 'heic':
    case 'heif':
    case 'avif': {
      score += 4;
      break;
    }
  }

  if (asset.type === AssetType.Video && asset.duration && asset.exifInfo?.fileSizeInByte) {
    // immich-go reads bitrate from FFprobe and scales it by codec efficiency. Neither is available
    // here, so this is the unadjusted average bitrate over the container.
    const bitrate = (asset.exifInfo.fileSizeInByte * 8) / (asset.duration / 1000);
    score += Math.min(12, 2 * Math.log2(1 + bitrate / 1e6));
  }

  score += Math.min(6, countMetadata(asset, albumCount) * 0.5);

  if (isProtected(asset)) {
    // Only a tie preference; never permission to discard.
    score -= 2;
  }

  return score;
};

const compilePatterns = (patterns: string[]): RegExp[] => {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, 'i'));
    } catch {
      // An unparseable user-supplied pattern must not take the duplicates page down; skip it.
    }
  }
  return compiled;
};

/**
 * Classifies an asset by where it lives on disk.
 *
 * This has no counterpart in immich-go: the uploader compares a local file against a server asset,
 * so it has no second server-side path to rank. On the duplicates page both copies are already in
 * the library, and their location is the best remaining evidence of which one the user curated --
 * without it a few KB of container overhead decides, which is what made this function suggest
 * trashing album copies in favour of Google Takeout scratch files.
 *
 * Scans path segments left to right and returns the tier of the *shallowest* segment that matches
 * either list. Shallowest-wins matters: an import-staging root often contains date-shaped
 * subfolders (`_2026-08-30 import intake/2012-10-15/...`), and the staging root is the truth about
 * that file, not the dated folder underneath it.
 */
export const getPathTier = (
  asset: AssetResponseDto,
  preferred: RegExp[],
  staging: RegExp[],
  originals: RegExp[] = compilePatterns(['^originals(_clean)?$']),
  macbookPro: RegExp[] = compilePatterns(['^uploads_macbookpro$']),
): PathTier => {
  const segments = asset.originalPath.split('/').filter(Boolean);

  // Highest tier: originals library (/mnt/originals or originals_clean)
  for (const segment of segments) {
    if (originals.some((pattern) => pattern.test(segment))) {
      return PathTier.Originals;
    }
  }
  if (/\/(originals|originals_clean)\b/i.test(asset.originalPath) || /^\/mnt\/originals\b/i.test(asset.originalPath)) {
    return PathTier.Originals;
  }

  // Second highest tier: MacBook Pro uploads (/mnt/uploads_macbookpro)
  for (const segment of segments) {
    if (macbookPro.some((pattern) => pattern.test(segment))) {
      return PathTier.UploadsMacbookPro;
    }
  }
  if (/\/uploads_macbookpro\b/i.test(asset.originalPath) || /^\/mnt\/uploads_macbookpro\b/i.test(asset.originalPath)) {
    return PathTier.UploadsMacbookPro;
  }

  // Curated vs staging based on shallowest matching segment
  for (const segment of segments) {
    if (staging.some((pattern) => pattern.test(segment))) {
      return PathTier.Staging;
    }

    if (preferred.some((pattern) => pattern.test(segment))) {
      return PathTier.Curated;
    }
  }

  return PathTier.Neutral;
};

export interface DuplicateQualityAssessment {
  hasOriginals: boolean;
  betterQualityOutsideOriginals: boolean;
  betterQualityAssetIds: string[];
  originalsAssetIds: string[];
}

export const assessDuplicateQuality = (
  assets: AssetResponseDto[],
  preference?: DuplicateKeepPreference,
  albumCounts?: Map<string, number>,
): DuplicateQualityAssessment => {
  const preferred = compilePatterns(preference?.preferredPathPatterns ?? []);
  const staging = compilePatterns(preference?.stagingPathPatterns ?? []);
  const originals = compilePatterns(preference?.originalsPathPatterns ?? ['^originals(_clean)?$']);
  const macbookPro = compilePatterns(preference?.macbookProPathPatterns ?? ['^uploads_macbookpro$']);

  const albumCountOf = (a: AssetResponseDto) => albumCounts?.get(a.id) ?? 0;
  const scored = assets.map((asset) => ({
    asset,
    score: getKeeperScore(asset, albumCountOf(asset)),
    tier: getPathTier(asset, preferred, staging, originals, macbookPro),
    pixels:
      (asset.width ?? asset.exifInfo?.exifImageWidth ?? 0) * (asset.height ?? asset.exifInfo?.exifImageHeight ?? 0),
  }));

  const originalsItems = scored.filter((s) => s.tier === PathTier.Originals);
  const outsideItems = scored.filter((s) => s.tier !== PathTier.Originals);

  if (originalsItems.length === 0 || outsideItems.length === 0) {
    return {
      hasOriginals: originalsItems.length > 0,
      betterQualityOutsideOriginals: false,
      betterQualityAssetIds: [],
      originalsAssetIds: originalsItems.map((s) => s.asset.id),
    };
  }

  const bestOriginalsScore = Math.max(...originalsItems.map((s) => s.score));
  const bestOriginalsPixels = Math.max(...originalsItems.map((s) => s.pixels));
  const scoreMargin = preference?.scoreMargin ?? 1;

  const betterOutside = outsideItems.filter(
    (s) =>
      s.score - bestOriginalsScore > scoreMargin ||
      (s.pixels > bestOriginalsPixels * 1.05 && s.score >= bestOriginalsScore - 0.5),
  );

  return {
    hasOriginals: true,
    betterQualityOutsideOriginals: betterOutside.length > 0,
    betterQualityAssetIds: betterOutside.map((s) => s.asset.id),
    originalsAssetIds: originalsItems.map((s) => s.asset.id),
  };
};

/**
 * Checks if a date falls into May-August 2015 or May-August 2021.
 * These dates are suspect due to a previous Claude automated EXIF batch mistake.
 */
export const isSuspectExifDate = (dateValue?: string | Date | null): boolean => {
  if (!dateValue) {
    return false;
  }
  const d = typeof dateValue === 'string' ? new Date(dateValue) : dateValue;
  if (isNaN(d.getTime())) {
    return false;
  }

  const yrUtc = d.getUTCFullYear();
  const moUtc = d.getUTCMonth() + 1; // 1-12
  if ((yrUtc === 2015 || yrUtc === 2021) && moUtc >= 5 && moUtc <= 8) {
    return true;
  }

  const yrLoc = d.getFullYear();
  const moLoc = d.getMonth() + 1;
  if ((yrLoc === 2015 || yrLoc === 2021) && moLoc >= 5 && moLoc <= 8) {
    return true;
  }

  return false;
};

export const isAssetDateSuspect = (asset: {
  localDateTime?: string | Date | null;
  exifInfo?: { dateTimeOriginal?: string | Date | null } | null;
  fileCreatedAt?: string | Date | null;
}): boolean => {
  return (
    isSuspectExifDate(asset.exifInfo?.dateTimeOriginal) ||
    isSuspectExifDate(asset.localDateTime) ||
    isSuspectExifDate(asset.fileCreatedAt)
  );
};

const getFileSize = (asset: AssetResponseDto): number => asset.exifInfo?.fileSizeInByte ?? 0;

/**
 * Matches common camera/hardware dump directories, mounts, or date-only folders
 * that do not represent curated human-named location or event organization.
 */
const GENERIC_SEGMENT_REGEX =
  /^(mnt|volume\d+(_\w+)?|photosync|docker|upload[s]?|usr|app|var|data|home|users|originals(_clean)?|uploads_macbookpro|uploads_immich|master photo library|mainphoto|laptop backup|photos|dcim|\d{3}[a-z0-9_]+|camera(_roll)?|sdcard|internal_storage|\d{4}|\d{2}|\d{4}[-_.]\d{2}([-_.]\d{2})?|\d{8}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december))$/i;

export interface FolderOrganizationScore {
  descriptiveSegmentsCount: number;
  depth: number;
  descriptiveLength: number;
}

/**
 * Quantifies how specifically organized an asset's folder path is.
 * Prefers files situated in descriptive geographical/thematic subfolders
 * (e.g. ".../aiAfrica/4mWestern Sahara/IMG_4657.JPG") over files sitting
 * unorganized at the root of a library or year folder.
 */
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

/**
 * The pre-existing upstream rule with tie-breaking: largest file wins, EXIF count breaks the tie,
 * folder organization breaks the tie, and last of the remaining equals wins.
 */
const suggestBySize = (assets: AssetResponseDto[]): AssetResponseDto | undefined => {
  if (assets.length === 0) {
    return undefined;
  }

  let candidates = [...assets].toSorted((a, b) => getFileSize(a) - getFileSize(b));
  const largestFileSize = getFileSize(candidates.at(-1)!);
  candidates = candidates.filter((asset) => getFileSize(asset) === largestFileSize);

  if (candidates.length >= 2) {
    candidates = candidates.toSorted((a, b) => getExifCount(a) - getExifCount(b));
    const highestExif = getExifCount(candidates.at(-1)!);
    candidates = candidates.filter((asset) => getExifCount(asset) === highestExif);
  }

  if (candidates.length >= 2) {
    candidates = candidates.toSorted((a, b) => {
      const orgA = getFolderOrganizationScore(a.originalPath);
      const orgB = getFolderOrganizationScore(b.originalPath);
      if (orgA.descriptiveSegmentsCount !== orgB.descriptiveSegmentsCount) {
        return orgA.descriptiveSegmentsCount - orgB.descriptiveSegmentsCount;
      }
      if (orgA.depth !== orgB.depth) {
        return orgA.depth - orgB.depth;
      }
      return orgA.descriptiveLength - orgB.descriptiveLength;
    });
  }

  return candidates.at(-1);
};

const pickBestRanked = (
  candidates: AssetResponseDto[],
  preferred: RegExp[],
  staging: RegExp[],
  originals: RegExp[],
  macbookPro: RegExp[],
  albumCounts?: Map<string, number>,
  sizeTolerance = 0.01,
): AssetResponseDto => {
  const albumCountOf = (asset: AssetResponseDto) => albumCounts?.get(asset.id) ?? 0;
  const rank = (asset: AssetResponseDto): number[] => {
    const org = getFolderOrganizationScore(asset.originalPath);
    return [
      albumCountOf(asset) > 0 ? 1 : 0,
      getPathTier(asset, preferred, staging, originals, macbookPro),
      asset.isFavorite ? 1 : 0,
      // eslint-disable-next-line eqeqeq
      asset.exifInfo?.latitude != null && asset.exifInfo?.longitude != null ? 1 : 0,
      getExifCount(asset) > 0 ? 1 : 0,
      org.descriptiveSegmentsCount,
      org.depth,
      getExifCount(asset),
      org.descriptiveLength,
    ];
  };

  const ranked = candidates.map((asset) => ({ asset, rank: rank(asset) }));
  let bestRank = ranked[0].rank;
  for (const current of ranked) {
    if (compareRanks(current.rank, bestRank) > 0) {
      bestRank = current.rank;
    }
  }
  let filtered = ranked.filter(({ rank }) => compareRanks(rank, bestRank) === 0).map(({ asset }) => asset);

  if (filtered.length === 1) {
    return filtered[0];
  }

  const largest = Math.max(...filtered.map((asset) => getFileSize(asset)));
  if (largest > 0) {
    filtered = filtered.filter((asset) => (largest - getFileSize(asset)) / largest <= sizeTolerance);
  }

  return filtered.length === 1 ? filtered[0] : (suggestBySize(filtered) ?? filtered[0]);
};

/**
 * Suggests the best duplicate asset to keep from a list of duplicates.
 *
 * Decision order:
 *  1. Originals library preference as highest tier (unless quality is better outside originals,
 *     which triggers flagging for manual migration).
 *  2. Uploads_macbookpro library preference as second highest tier.
 *  3. Keeper score lead if one copy leads by more than `scoreMargin`.
 *  4. Path tier, album membership, favorite, GPS, EXIF count.
 *  5. File size within `sizeTolerance`.
 *  6. Upstream size-only fallback.
 */
export const suggestDuplicate = (
  assets: AssetResponseDto[],
  preference?: DuplicateKeepPreference,
  albumCounts?: Map<string, number>,
): AssetResponseDto | undefined => {
  if (assets.length === 0) {
    return undefined;
  }

  if (assets.length === 1 || !preference?.enabled) {
    return suggestBySize(assets);
  }

  const preferred = compilePatterns(preference.preferredPathPatterns);
  const staging = compilePatterns(preference.stagingPathPatterns);
  const originals = compilePatterns(preference.originalsPathPatterns ?? ['^originals(_clean)?$']);
  const macbookPro = compilePatterns(preference.macbookProPathPatterns ?? ['^uploads_macbookpro$']);

  const albumCountOf = (asset: AssetResponseDto) => albumCounts?.get(asset.id) ?? 0;

  const scored = assets.map((asset) => ({
    asset,
    score: getKeeperScore(asset, albumCountOf(asset)),
    tier: getPathTier(asset, preferred, staging, originals, macbookPro),
  }));

  const originalsItems = scored.filter((s) => s.tier === PathTier.Originals);
  const macbookProItems = scored.filter((s) => s.tier === PathTier.UploadsMacbookPro);

  // Preference for originals as highest tier:
  if (originalsItems.length > 0) {
    const quality = assessDuplicateQuality(assets, preference, albumCounts);
    if (quality.betterQualityOutsideOriginals) {
      // Quality is better outside originals: the tool flags this so the user can migrate manually.
      // For a single suggestion, pick the highest quality outside candidate.
      // (Note: suggestDuplicateKeepAssetIds preserves BOTH to prevent deletion).
      const bestOutside = scored
        .filter((s) => quality.betterQualityAssetIds.includes(s.asset.id))
        .sort((a, b) => b.score - a.score)[0];
      return bestOutside?.asset ?? originalsItems[0].asset;
    }

    // Quality in originals is equal to, within margin, or better than outside: Originals wins!
    let candidates = originalsItems;
    const bestOrigScore = Math.max(...candidates.map((s) => s.score));
    candidates = candidates.filter((s) => bestOrigScore - s.score <= preference.scoreMargin);

    if (candidates.length === 1) {
      return candidates[0].asset;
    }

    return pickBestRanked(
      candidates.map((s) => s.asset),
      preferred,
      staging,
      originals,
      macbookPro,
      albumCounts,
      preference.sizeTolerance,
    );
  }

  // Preference for uploads_macbookpro as second highest tier:
  if (macbookProItems.length > 0) {
    const bestMbScore = Math.max(...macbookProItems.map((s) => s.score));
    const betterOutside = scored.filter(
      (s) => s.tier < PathTier.UploadsMacbookPro && s.score - bestMbScore > preference.scoreMargin,
    );

    if (betterOutside.length === 0) {
      // UploadsMacbookPro wins!
      let candidates = macbookProItems.filter((s) => bestMbScore - s.score <= preference.scoreMargin);
      if (candidates.length === 1) {
        return candidates[0].asset;
      }
      return pickBestRanked(
        candidates.map((s) => s.asset),
        preferred,
        staging,
        originals,
        macbookPro,
        albumCounts,
        preference.sizeTolerance,
      );
    }
  }

  // General case: keeper score lead if > scoreMargin, else tier ranking and tie-breakers
  const bestScore = Math.max(...scored.map(({ score }) => score));
  let candidates = scored.filter(({ score }) => bestScore - score <= preference.scoreMargin).map(({ asset }) => asset);

  if (candidates.length === 1) {
    return candidates[0];
  }

  return pickBestRanked(
    candidates,
    preferred,
    staging,
    originals,
    macbookPro,
    albumCounts,
    preference.sizeTolerance,
  );
};

const compareRanks = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
};

/**
 * Suggests the best duplicate asset IDs to keep from a list of duplicates.
 * When better quality exists outside of originals, preserves BOTH the originals copy
 * and the higher quality copy so neither is trashed before manual migration.
 *
 * @param assets List of duplicate assets
 * @param preference Tunables; see {@link suggestDuplicate}
 * @param albumCounts Map of asset id -> number of albums the asset belongs to
 * @returns Array of suggested asset IDs to keep
 */
export const suggestDuplicateKeepAssetIds = (
  assets: AssetResponseDto[],
  preference?: DuplicateKeepPreference,
  albumCounts?: Map<string, number>,
): string[] => {
  if (assets.length === 0) {
    return [];
  }

  if (preference?.enabled) {
    const quality = assessDuplicateQuality(assets, preference, albumCounts);
    if (quality.betterQualityOutsideOriginals) {
      // Keep both the originals copy and the better-quality outside copy
      const keepIds = new Set<string>();
      for (const id of quality.originalsAssetIds) {
        keepIds.add(id);
      }
      for (const id of quality.betterQualityAssetIds) {
        keepIds.add(id);
      }
      return [...keepIds];
    }
  }

  const suggested = suggestDuplicate(assets, preference, albumCounts);
  return suggested ? [suggested.id] : [];
};
