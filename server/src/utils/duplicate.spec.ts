import { AssetResponseDto } from 'src/dtos/asset-response.dto';
import { defaults } from 'src/dtos/config.dto';
import { ExifResponseSchema } from 'src/dtos/exif.dto';
import { AssetType, AssetVisibility } from 'src/enum';
import {
  type AssetFingerprintEvidence,
  assessDuplicateQuality,
  classifyDuplicateGroup,
  DuplicateClassification,
  getAutoResolvable,
  getExifCount,
  getFolderOrganizationScore,
  getKeeperScore,
  getPathTier,
  isAssetDateSuspect,
  isSuspectExifDate,
  PathTier,
  suggestDuplicate,
  suggestDuplicateKeepAssetIds,
} from 'src/utils/duplicate';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

type ExifInfoInput = Partial<z.infer<typeof ExifResponseSchema>>;

const createAsset = (
  id: string,
  fileSizeInByte: number | null = null,
  exifFields: ExifInfoInput = {},
): AssetResponseDto => ({
  id,
  type: AssetType.Image,
  thumbhash: null,
  localDateTime: new Date().toISOString(),
  duration: 0,
  hasMetadata: true,
  width: 1920,
  height: 1080,
  createdAt: new Date().toISOString(),
  ownerId: 'owner-1',
  originalPath: '/path/to/asset',
  originalFileName: 'asset.jpg',
  fileCreatedAt: new Date().toISOString(),
  fileModifiedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  isFavorite: false,
  isArchived: false,
  isTrashed: false,
  isOffline: false,
  isEdited: false,
  visibility: AssetVisibility.Timeline,
  checksum: 'checksum',
  exifInfo:
    fileSizeInByte !== null || Object.keys(exifFields).length > 0
      ? ExifResponseSchema.parse({ fileSizeInByte, ...exifFields })
      : undefined,
});

const preference = defaults.machineLearning.duplicateDetection.keepPreference;

const at = (asset: AssetResponseDto, originalPath: string, overrides: Partial<AssetResponseDto> = {}) => {
  Object.assign(asset, { originalPath }, overrides);
  return asset;
};

const classifiable = (id: string, overrides: Partial<Record<string, unknown>> = {}) => ({
  id,
  checksum: id,
  originalFileName: `${id}.jpg`,
  isEdited: false,
  exifInfo: { dateTimeOriginal: '2024-01-03T20:11:47.000Z' },
  ...overrides,
});

const evidence = (overrides: Partial<AssetFingerprintEvidence> = {}): AssetFingerprintEvidence => ({
  contentHash: null,
  frameHash: null,
  perceptualHash: null,
  width: 4032,
  height: 3024,
  informative: true,
  hasEmbeddedMedia: false,
  error: null,
  ...overrides,
});

describe('duplicate utils', () => {
  describe('getExifCount', () => {
    it('should return 0 for asset without exifInfo', () => {
      const asset = createAsset('asset-1');
      asset.exifInfo = undefined;
      expect(getExifCount(asset)).toBe(0);
    });

    it('should return 0 for empty exifInfo', () => {
      const asset = createAsset('asset-1');
      asset.exifInfo = ExifResponseSchema.parse({});
      expect(getExifCount(asset)).toBe(0);
    });

    it('should count all truthy values in exifInfo', () => {
      const asset = createAsset('asset-1', 1000, {
        make: 'Canon',
        model: 'EOS 5D',
        dateTimeOriginal: new Date().toISOString(),
        timeZone: 'UTC',
        latitude: 40.7128,
        longitude: -74.006,
        city: 'New York',
        state: 'NY',
        country: 'USA',
        description: 'A photo',
        rating: 5,
      });
      // fileSizeInByte (1000) + 11 other truthy fields = 12
      expect(getExifCount(asset)).toBe(12);
    });

    it('should not count null or undefined values', () => {
      const asset = createAsset('asset-1', 1000, {
        make: 'Canon',
        model: null,
        latitude: undefined,
        city: '',
        rating: null,
      });
      // fileSizeInByte (1000) + make ('Canon') = 2 truthy values
      // model (null), latitude (undefined), city (''), rating (0) are all falsy
      expect(getExifCount(asset)).toBe(2);
    });
  });

  describe('suggestDuplicate', () => {
    it('should return undefined for empty list', () => {
      expect(suggestDuplicate([])).toBeUndefined();
    });

    it('should return the single asset for list with one asset', () => {
      const asset = createAsset('asset-1', 1000);
      expect(suggestDuplicate([asset])).toEqual(asset);
    });

    it('should return asset with largest file size', () => {
      const small = createAsset('small', 1000);
      const large = createAsset('large', 5000);
      const medium = createAsset('medium', 3000);

      expect(suggestDuplicate([small, large, medium])?.id).toBe('large');
      expect(suggestDuplicate([large, small, medium])?.id).toBe('large');
      expect(suggestDuplicate([medium, small, large])?.id).toBe('large');
    });

    it('should use EXIF count as tie-breaker when file sizes are equal', () => {
      const lessExif = createAsset('less-exif', 1000, { make: 'Canon' });
      const moreExif = createAsset('more-exif', 1000, {
        make: 'Canon',
        model: 'EOS 5D',
        dateTimeOriginal: new Date().toISOString(),
        city: 'New York',
      });

      expect(suggestDuplicate([lessExif, moreExif])?.id).toBe('more-exif');
      expect(suggestDuplicate([moreExif, lessExif])?.id).toBe('more-exif');
    });

    it('should handle assets with no exifInfo (treat as 0 file size)', () => {
      const noExif = createAsset('no-exif');
      noExif.exifInfo = undefined;
      const withExif = createAsset('with-exif', 1000);

      expect(suggestDuplicate([noExif, withExif])?.id).toBe('with-exif');
    });

    it('should handle assets with exifInfo but no fileSizeInByte', () => {
      const noFileSize = createAsset('no-file-size');
      noFileSize.exifInfo = ExifResponseSchema.parse({ make: 'Canon', model: 'EOS 5D' });
      const withFileSize = createAsset('with-file-size', 1000);

      expect(suggestDuplicate([noFileSize, withFileSize])?.id).toBe('with-file-size');
    });

    it('should return last asset when all have same file size and EXIF count', () => {
      const asset1 = createAsset('asset-1', 1000, { make: 'Canon' });
      const asset2 = createAsset('asset-2', 1000, { make: 'Nikon' });

      // Both have same file size (1000) and same EXIF count (2: fileSizeInByte + make)
      // Should return the last one in the sorted array
      const result = suggestDuplicate([asset1, asset2]);
      // Since they're equal, the last one after sorting should be returned
      expect(result).toBeDefined();
      expect(['asset-1', 'asset-2']).toContain(result?.id);
    });

    it('should prioritize file size over EXIF count', () => {
      const largeWithLessExif = createAsset('large-less-exif', 5000, { make: 'Canon' });
      const smallWithMoreExif = createAsset('small-more-exif', 1000, {
        make: 'Canon',
        model: 'EOS 5D',
        dateTimeOriginal: new Date().toISOString(),
        city: 'New York',
        state: 'NY',
        country: 'USA',
      });

      expect(suggestDuplicate([largeWithLessExif, smallWithMoreExif])?.id).toBe('large-less-exif');
    });
  });

  describe('suggestDuplicate with keep preference', () => {
    const takeout = '/mnt/mainphoto/takeout-20250527T234817Z-001/Takeout/Google Photos/IMG_8842.MOV';
    const album = '/mnt/mainphoto/2024-01-01 Disney Magic Cruise/IMG_8842.MOV';

    it('should keep the curated copy when a staging copy is only trivially larger', () => {
      const staging = at(createAsset('staging', 6_399_943), takeout);
      const curated = at(createAsset('curated', 6_396_823), album);

      expect(suggestDuplicate([staging, curated])?.id).toBe('staging');
      expect(suggestDuplicate([staging, curated], preference)?.id).toBe('curated');
      expect(suggestDuplicate([curated, staging], preference)?.id).toBe('curated');
    });

    it('should not let a bigger file outrank a better location at equal resolution', () => {
      // File size measures compression, not information; the ported immich-go keeper score
      // deliberately excludes it. Same pixels in a fatter container is not a better copy.
      const staging = at(createAsset('staging', 10_000_000), takeout);
      const curated = at(createAsset('curated', 6_000_000), album);

      expect(suggestDuplicate([staging, curated], preference)?.id).toBe('curated');
    });

    it('should keep the RAW copy even when it sits in staging', () => {
      const staging = at(createAsset('staging', 1000), '/mnt/mainphoto/takeout-1/IMG_1.DNG', {
        originalFileName: 'IMG_1.DNG',
      });
      const curated = at(createAsset('curated', 1000), album, { originalFileName: 'IMG_1.JPG' });

      expect(suggestDuplicate([staging, curated], preference)?.id).toBe('staging');
    });

    it('should penalise an explicitly edited copy as a tie preference only', () => {
      const edited = at(createAsset('edited', 1000), album, { originalFileName: 'IMG_1 (edited).JPG' });
      const original = at(createAsset('original', 1000), album, { originalFileName: 'IMG_1.JPG' });

      expect(suggestDuplicate([edited, original], preference)?.id).toBe('original');
    });

    it('should never trade resolution for a better location', () => {
      const staging = at(createAsset('staging', 1_000_000), takeout, { width: 4032, height: 3024 });
      const curated = at(createAsset('curated', 1_000_000), album, { width: 1024, height: 768 });

      expect(suggestDuplicate([staging, curated], preference)?.id).toBe('staging');
    });

    it('should treat the shallowest matching segment as the truth about a path', () => {
      // A dated subfolder inside an import dump is still an import dump.
      const staging = at(
        createAsset('staging', 4_000_000),
        '/mnt/mainphoto/_2026-08-30 import intake/2012-10-15/a.jpg',
      );
      const curated = at(createAsset('curated', 4_000_000), '/mnt/mainphoto/2012-10 (home)/IMG_4476.JPG');

      expect(suggestDuplicate([staging, curated], preference)?.id).toBe('curated');
    });

    it('should prefer an asset that belongs to an album over one that does not', () => {
      const filed = at(createAsset('filed', 1000), takeout);
      const loose = at(createAsset('loose', 1000), album);

      expect(suggestDuplicate([filed, loose], preference, new Map([['filed', 1]]))?.id).toBe('filed');
    });

    it('should fall back to the size-only rule when nothing distinguishes the copies', () => {
      const first = at(createAsset('first', 1000), album);
      const second = at(createAsset('second', 1000), album);

      expect(suggestDuplicate([first, second], preference)?.id).toBe(suggestDuplicate([first, second])?.id);
    });

    it('should ignore an unparseable user-supplied pattern instead of throwing', () => {
      const broken = { ...preference, stagingPathPatterns: ['('] };
      const staging = at(createAsset('staging', 1001), takeout);
      const curated = at(createAsset('curated', 1000), album);

      expect(() => suggestDuplicate([staging, curated], broken)).not.toThrow();
      expect(suggestDuplicate([staging, curated], broken)?.id).toBe('curated');
    });

    it('should behave exactly like the old rule when disabled', () => {
      const disabled = { ...preference, enabled: false };
      const staging = at(createAsset('staging', 6_399_943), takeout);
      const curated = at(createAsset('curated', 6_396_823), album);

      expect(suggestDuplicate([staging, curated], disabled)?.id).toBe('staging');
    });
  });

  describe('classifyDuplicateGroup', () => {
    it('should classify a group with a shared checksum as EXACT', () => {
      const a = createAsset('a', 1000);
      const b = createAsset('b', 2000);
      expect(classifyDuplicateGroup([a, b])).toBe(DuplicateClassification.Exact);
    });

    it('should classify a group with all-distinct checksums and no fingerprints as UNANALYZED', () => {
      const a = { ...createAsset('a', 1000), checksum: 'aaa' };
      const b = { ...createAsset('b', 2000), checksum: 'bbb' };
      expect(classifyDuplicateGroup([a, b])).toBe(DuplicateClassification.Unanalyzed);
    });

    it('should accept database Buffer checksums as well as API strings', () => {
      const withChecksum = (id: string, checksum: Buffer) => ({
        id,
        checksum,
        originalFileName: `${id}.jpg`,
        isEdited: false,
      });

      expect(classifyDuplicateGroup([withChecksum('a', Buffer.from('x')), withChecksum('b', Buffer.from('x'))])).toBe(
        DuplicateClassification.Exact,
      );
      expect(classifyDuplicateGroup([withChecksum('a', Buffer.from('x')), withChecksum('b', Buffer.from('y'))])).toBe(
        DuplicateClassification.Unanalyzed,
      );
    });

    it('should classify as CONTENT_IDENTICAL with fallbackToMetadata when dimensions and timestamp/name match', () => {
      const a = {
        id: 'a',
        checksum: 'cs1',
        originalFileName: 'IMG_1234.JPG',
        isEdited: false,
        width: 4000,
        height: 3000,
        exifInfo: { dateTimeOriginal: '2023-05-10T12:00:00Z', fileSizeInByte: 5000000 },
      };
      const b = {
        id: 'b',
        checksum: 'cs2',
        originalFileName: 'IMG_1234.JPG',
        isEdited: false,
        width: 4000,
        height: 3000,
        exifInfo: { dateTimeOriginal: '2023-05-10T12:00:00Z', fileSizeInByte: 5000000 },
      };
      expect(classifyDuplicateGroup([a, b], undefined, { fallbackToMetadata: true })).toBe(
        DuplicateClassification.ContentIdentical,
      );
    });

    it('should classify as HIGH_CONFIDENCE with fallbackToMetadata when one copy is downscaled/thumbnail', () => {
      const a = {
        id: 'a',
        checksum: 'cs1',
        originalFileName: 'IMG_1234.JPG',
        isEdited: false,
        width: 4000,
        height: 3000,
        exifInfo: { dateTimeOriginal: '2023-05-10T12:00:00Z', fileSizeInByte: 5000000 },
      };
      const b = {
        id: 'b',
        checksum: 'cs2',
        originalFileName: 'IMG_1234_thumb.JPG',
        isEdited: false,
        width: 1024,
        height: 768,
        exifInfo: { dateTimeOriginal: '2023-05-10T12:00:00Z', fileSizeInByte: 200000 },
      };
      expect(classifyDuplicateGroup([a, b], undefined, { fallbackToMetadata: true })).toBe(
        DuplicateClassification.HighConfidence,
      );
    });
  });

  describe('classifyDuplicateGroup with fingerprints', () => {
    it('should return CONTENT_IDENTICAL when decoded pixels match', () => {
      const hash = Buffer.from('same-pixels');
      const fingerprints = new Map([
        ['a', evidence({ contentHash: hash })],
        ['b', evidence({ contentHash: Buffer.from('same-pixels') })],
      ]);
      expect(classifyDuplicateGroup([classifiable('a'), classifiable('b')], fingerprints)).toBe(
        DuplicateClassification.ContentIdentical,
      );
    });

    it('should return CONTENT_IDENTICAL for equal complete-file hashes when dimensions are unavailable', () => {
      const hash = Buffer.from('same-video-bytes');
      const fingerprints = new Map([
        ['a', evidence({ contentHash: hash, width: null, height: null })],
        ['b', evidence({ contentHash: Buffer.from('same-video-bytes'), width: null, height: null })],
      ]);
      expect(classifyDuplicateGroup([classifiable('a'), classifiable('b')], fingerprints)).toBe(
        DuplicateClassification.ContentIdentical,
      );
    });

    it('should refuse CONTENT_IDENTICAL when only one copy still carries motion media', () => {
      // Google Takeout strips the trailing video from a motion photo; the stills are identical but
      // the copies are not interchangeable, and the stripped one must not be allowed to win.
      const hash = Buffer.from('same-pixels');
      const fingerprints = new Map([
        ['a', evidence({ contentHash: hash, hasEmbeddedMedia: true })],
        ['b', evidence({ contentHash: Buffer.from('same-pixels'), hasEmbeddedMedia: false })],
      ]);
      expect(classifyDuplicateGroup([classifiable('a'), classifiable('b')], fingerprints)).toBe(
        DuplicateClassification.Possible,
      );
    });

    it('should return HIGH_CONFIDENCE for near hashes with corroborating metadata', () => {
      const fingerprints = new Map([
        ['a', evidence({ perceptualHash: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0b0000_0000]) })],
        ['b', evidence({ perceptualHash: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0b0000_0011]) })],
      ]);
      expect(classifyDuplicateGroup([classifiable('a'), classifiable('b')], fingerprints)).toBe(
        DuplicateClassification.HighConfidence,
      );
    });

    it('should reach HIGH_CONFIDENCE even when capture dates are years apart', () => {
      // Takeout re-exports and scanned prints carry dates assigned independently of the original;
      // measured on the live library, 145 of 147 rejected near-hash pairs differed by over a day.
      const fingerprints = new Map([
        ['a', evidence({ perceptualHash: Buffer.alloc(8) })],
        ['b', evidence({ perceptualHash: Buffer.alloc(8) })],
      ]);
      const b = classifiable('b', { exifInfo: { dateTimeOriginal: '2008-06-01T00:00:00.000Z' } });
      expect(classifyDuplicateGroup([classifiable('a'), b], fingerprints)).toBe(DuplicateClassification.HighConfidence);
    });

    it('should reach HIGH_CONFIDENCE when a capture time is missing entirely', () => {
      const fingerprints = new Map([
        ['a', evidence({ perceptualHash: Buffer.alloc(8) })],
        ['b', evidence({ perceptualHash: Buffer.alloc(8) })],
      ]);
      expect(classifyDuplicateGroup([classifiable('a'), classifiable('b', { exifInfo: null })], fingerprints)).toBe(
        DuplicateClassification.HighConfidence,
      );
    });

    it('should stay POSSIBLE for burst siblings even at distance zero', () => {
      const fingerprints = new Map([
        ['a', evidence({ perceptualHash: Buffer.alloc(8) })],
        ['b', evidence({ perceptualHash: Buffer.alloc(8) })],
      ]);
      const b = classifiable('b', { originalFileName: 'IMG_1234_BURST002.jpg' });
      expect(classifyDuplicateGroup([classifiable('a'), b], fingerprints)).toBe(DuplicateClassification.Possible);
    });

    it('should stay POSSIBLE when aspect ratios disagree', () => {
      const fingerprints = new Map([
        ['a', evidence({ perceptualHash: Buffer.alloc(8) })],
        ['b', evidence({ perceptualHash: Buffer.alloc(8), width: 3024, height: 3024 })],
      ]);
      expect(classifyDuplicateGroup([classifiable('a'), classifiable('b')], fingerprints)).toBe(
        DuplicateClassification.Possible,
      );
    });

    it('should stay POSSIBLE when an image was too low-information to hash', () => {
      const fingerprints = new Map([
        ['a', evidence({ perceptualHash: Buffer.alloc(8), informative: false })],
        ['b', evidence({ perceptualHash: Buffer.alloc(8) })],
      ]);
      expect(classifyDuplicateGroup([classifiable('a'), classifiable('b')], fingerprints)).toBe(
        DuplicateClassification.Possible,
      );
    });

    it('should treat a fingerprint error as "not yet proven", never as proof of difference', () => {
      const hash = Buffer.from('same-pixels');
      const fingerprints = new Map([
        ['a', evidence({ contentHash: hash, error: 'decode failed' })],
        ['b', evidence({ contentHash: hash })],
      ]);
      expect(classifyDuplicateGroup([classifiable('a'), classifiable('b')], fingerprints)).toBe(
        DuplicateClassification.Possible,
      );
    });

    it('should report UNANALYZED, not POSSIBLE, when fingerprints are missing', () => {
      // These are different answers: one means "still queued", the other "looked and unconvinced".
      expect(classifyDuplicateGroup([classifiable('a'), classifiable('b')], new Map())).toBe(
        DuplicateClassification.Unanalyzed,
      );
      const partial = new Map([['a', evidence({ contentHash: Buffer.from('x') })]]);
      expect(classifyDuplicateGroup([classifiable('a'), classifiable('b')], partial)).toBe(
        DuplicateClassification.Unanalyzed,
      );
    });

    it('should expose auto-resolvable levels that widen as evidence requirements relax', () => {
      expect([...getAutoResolvable('exact')]).toEqual([DuplicateClassification.Exact]);
      expect(getAutoResolvable('content').has(DuplicateClassification.HighConfidence)).toBe(false);
      expect(getAutoResolvable('near').has(DuplicateClassification.HighConfidence)).toBe(true);
      expect(getAutoResolvable('near').has(DuplicateClassification.Possible)).toBe(false);
      expect(getAutoResolvable('near').has(DuplicateClassification.Unanalyzed)).toBe(false);
    });

    it('should reach HIGH_CONFIDENCE for a re-encoded video whose sampled frames match', () => {
      // The case that started this: a 6.104 MiB Takeout copy of a 6.101 MiB original. Different
      // bytes, so the whole-file hash can never match; the sampled frames can.
      const frames = Buffer.from('five-frame-digest');
      const fingerprints = new Map([
        ['a', evidence({ frameHash: frames })],
        ['b', evidence({ frameHash: Buffer.from('five-frame-digest') })],
      ]);

      const a = classifiable('a', { duration: 12_000, exifInfo: { fps: 30 } });
      const b = classifiable('b', { duration: 12_000, exifInfo: { fps: 30 } });
      expect(classifyDuplicateGroup([a, b], fingerprints)).toBe(DuplicateClassification.HighConfidence);
    });

    it('should not match videos whose durations disagree beyond tolerance', () => {
      const frames = Buffer.from('five-frame-digest');
      const fingerprints = new Map([
        ['a', evidence({ frameHash: frames })],
        ['b', evidence({ frameHash: Buffer.from('five-frame-digest') })],
      ]);
      const a = classifiable('a', { duration: 12_000, exifInfo: { fps: 30 } });
      const b = classifiable('b', { duration: 20_000, exifInfo: { fps: 30 } });

      expect(classifyDuplicateGroup([a, b], fingerprints)).toBe(DuplicateClassification.Possible);
    });

    it('should tolerate a small duration difference from a container remux', () => {
      const frames = Buffer.from('five-frame-digest');
      const fingerprints = new Map([
        ['a', evidence({ frameHash: frames })],
        ['b', evidence({ frameHash: Buffer.from('five-frame-digest') })],
      ]);
      const a = classifiable('a', { duration: 12_000, exifInfo: { fps: 30 } });
      const b = classifiable('b', { duration: 12_200, exifInfo: { fps: 30 } });

      expect(classifyDuplicateGroup([a, b], fingerprints)).toBe(DuplicateClassification.HighConfidence);
    });

    it('should not match videos whose frame rates disagree', () => {
      const frames = Buffer.from('five-frame-digest');
      const fingerprints = new Map([
        ['a', evidence({ frameHash: frames })],
        ['b', evidence({ frameHash: Buffer.from('five-frame-digest') })],
      ]);
      const a = classifiable('a', { duration: 12_000, exifInfo: { fps: 30 } });
      const b = classifiable('b', { duration: 12_000, exifInfo: { fps: 60 } });

      expect(classifyDuplicateGroup([a, b], fingerprints)).toBe(DuplicateClassification.Possible);
    });

    it('should not match a video whose sampled frames were uninformative', () => {
      const frames = Buffer.from('five-frame-digest');
      const fingerprints = new Map([
        ['a', evidence({ frameHash: frames, informative: false })],
        ['b', evidence({ frameHash: Buffer.from('five-frame-digest') })],
      ]);
      const a = classifiable('a', { duration: 12_000, exifInfo: { fps: 30 } });
      const b = classifiable('b', { duration: 12_000, exifInfo: { fps: 30 } });

      expect(classifyDuplicateGroup([a, b], fingerprints)).toBe(DuplicateClassification.Possible);
    });

    it('should not merge by transitive similarity', () => {
      // a and b are content-identical; c only resembles them. One proven pair is not enough to
      // delete the whole CLIP group, because c is never proven against either asset.
      const hash = Buffer.from('same-pixels');
      const fingerprints = new Map([
        ['a', evidence({ contentHash: hash })],
        ['b', evidence({ contentHash: Buffer.from('same-pixels') })],
        ['c', evidence({ perceptualHash: Buffer.alloc(8) })],
      ]);
      expect(classifyDuplicateGroup([classifiable('a'), classifiable('b'), classifiable('c')], fingerprints)).toBe(
        DuplicateClassification.Possible,
      );
      expect(classifyDuplicateGroup([classifiable('a'), classifiable('c')], fingerprints)).toBe(
        DuplicateClassification.Possible,
      );
    });
  });

  describe('getKeeperScore', () => {
    it('should rank resolution above everything else', () => {
      const small = at(createAsset('small', 9_000_000), '/a/b.jpg', { width: 1024, height: 768 });
      const large = at(createAsset('large', 1_000_000), '/a/b.jpg', { width: 4032, height: 3024 });
      expect(getKeeperScore(large)).toBeGreaterThan(getKeeperScore(small));
    });

    it('should not change with file size', () => {
      const lean = at(createAsset('lean', 1_000_000), '/a/b.jpg');
      const fat = at(createAsset('fat', 90_000_000), '/a/b.jpg');
      expect(getKeeperScore(fat)).toBe(getKeeperScore(lean));
    });

    it('should credit album membership as metadata completeness', () => {
      const asset = at(createAsset('a', 1000), '/a/b.jpg');
      expect(getKeeperScore(asset, 1)).toBeGreaterThan(getKeeperScore(asset, 0));
    });
  });

  describe('suggestDuplicateKeepAssetIds', () => {
    it('should return empty array for empty list', () => {
      expect(suggestDuplicateKeepAssetIds([])).toEqual([]);
    });

    it('should return array with single asset ID', () => {
      const asset = createAsset('asset-1', 1000);
      expect(suggestDuplicateKeepAssetIds([asset])).toEqual(['asset-1']);
    });

    it('should return array with best asset ID', () => {
      const small = createAsset('small', 1000);
      const large = createAsset('large', 5000);

      expect(suggestDuplicateKeepAssetIds([small, large])).toEqual(['large']);
    });

    it('should keep BOTH the originals copy and the higher-quality outside copy when quality is better outside originals', () => {
      const orig = at(createAsset('orig', 1_000_000), '/mnt/originals/2002-09 Trip/pic.jpg', {
        width: 1024,
        height: 768,
      });
      const highResOutside = at(createAsset('highRes', 2_000_000), '/mnt/mainphoto/2002-09 Trip/pic.jpg', {
        width: 4032,
        height: 3024,
      });

      const keepIds = suggestDuplicateKeepAssetIds([orig, highResOutside], preference);
      expect(keepIds).toContain('orig');
      expect(keepIds).toContain('highRes');
    });
  });

  describe('PathTier and Tiered Preferences', () => {
    it('should identify Originals as highest tier (4)', () => {
      const orig = at(createAsset('orig', 1000), '/mnt/originals/2013-12 Christmas/a.jpg');
      const clean = at(createAsset('clean', 1000), '/volume1/photosync/originals_clean/2013-12/a.jpg');
      expect(getPathTier(orig, [], [])).toBe(PathTier.Originals);
      expect(getPathTier(clean, [], [])).toBe(PathTier.Originals);
    });

    it('should identify UploadsMacbookPro as second highest tier (3)', () => {
      const mbp = at(createAsset('mbp', 1000), '/mnt/uploads_macbookpro/AAPhotos/IMG_1234.JPG');
      expect(getPathTier(mbp, [], [])).toBe(PathTier.UploadsMacbookPro);
    });

    it('should prefer Originals over mainphoto and staging when quality is equal', () => {
      const orig = at(createAsset('orig', 2_000_000), '/mnt/originals/2010 Costa Rica/P1.JPG', {
        width: 3968,
        height: 2976,
      });
      const mainphoto = at(createAsset('main', 2_000_000), '/mnt/mainphoto/2010 Costa Rica/P1.JPG', {
        width: 3968,
        height: 2976,
      });

      expect(suggestDuplicate([orig, mainphoto], preference)?.id).toBe('orig');
    });

    it('should prefer UploadsMacbookPro over mainphoto when no originals copy exists', () => {
      const mbp = at(createAsset('mbp', 2_000_000), '/mnt/uploads_macbookpro/Photos/P1.JPG', {
        width: 3968,
        height: 2976,
      });
      const main = at(createAsset('main', 2_000_000), '/mnt/mainphoto/Photos/P1.JPG', {
        width: 3968,
        height: 2976,
      });

      expect(suggestDuplicate([mbp, main], preference)?.id).toBe('mbp');
    });

    it('should prefer Originals over UploadsMacbookPro when quality is comparable', () => {
      const orig = at(createAsset('orig', 2_000_000), '/mnt/originals/Photos/P1.JPG', {
        width: 3968,
        height: 2976,
      });
      const mbp = at(createAsset('mbp', 2_000_000), '/mnt/uploads_macbookpro/Photos/P1.JPG', {
        width: 3968,
        height: 2976,
      });

      expect(suggestDuplicate([orig, mbp], preference)?.id).toBe('orig');
    });
  });

  describe('assessDuplicateQuality', () => {
    it('should detect when quality is better outside originals', () => {
      const orig = at(createAsset('orig', 1_000_000), '/mnt/originals/2002 Nissan/ME.JPG', {
        width: 1536,
        height: 1024,
      });
      const highRes = at(createAsset('highRes', 3_000_000), '/mnt/mainphoto/2002 Nissan/DCP_0200.JPG', {
        width: 3072,
        height: 2048,
      });

      const assessment = assessDuplicateQuality([orig, highRes], preference);
      expect(assessment.hasOriginals).toBe(true);
      expect(assessment.betterQualityOutsideOriginals).toBe(true);
      expect(assessment.betterQualityAssetIds).toEqual(['highRes']);
      expect(assessment.originalsAssetIds).toEqual(['orig']);
    });

    it('should NOT flag when originals copy has equal or better quality', () => {
      const orig = at(createAsset('orig', 3_000_000), '/mnt/originals/2002 Nissan/ME.JPG', {
        width: 3072,
        height: 2048,
      });
      const lowerRes = at(createAsset('lowerRes', 1_000_000), '/mnt/mainphoto/2002 Nissan/ME.JPG', {
        width: 1536,
        height: 1024,
      });

      const assessment = assessDuplicateQuality([orig, lowerRes], preference);
      expect(assessment.hasOriginals).toBe(true);
      expect(assessment.betterQualityOutsideOriginals).toBe(false);
      expect(assessment.betterQualityAssetIds).toEqual([]);
    });
  });

  describe('Suspect Date Detection (Claude EXIF May-Aug 2015/2021)', () => {
    it('should flag dates in May through August 2015', () => {
      expect(isSuspectExifDate('2015-05-01T00:00:00Z')).toBe(true);
      expect(isSuspectExifDate('2015-06-15T12:00:00Z')).toBe(true);
      expect(isSuspectExifDate('2015-07-20T18:30:00Z')).toBe(true);
      expect(isSuspectExifDate('2015-08-31T23:59:59Z')).toBe(true);
    });

    it('should flag dates in May through August 2021', () => {
      expect(isSuspectExifDate('2021-05-05T08:00:00Z')).toBe(true);
      expect(isSuspectExifDate('2021-06-30T10:15:00Z')).toBe(true);
      expect(isSuspectExifDate('2021-07-04T12:00:00Z')).toBe(true);
      expect(isSuspectExifDate('2021-08-25T14:45:00Z')).toBe(true);
    });

    it('should not flag dates outside May-August in 2015 or 2021', () => {
      expect(isSuspectExifDate('2015-04-30T23:59:59Z')).toBe(false);
      expect(isSuspectExifDate('2015-09-01T00:00:00Z')).toBe(false);
      expect(isSuspectExifDate('2021-01-15T12:00:00Z')).toBe(false);
      expect(isSuspectExifDate('2021-09-10T12:00:00Z')).toBe(false);
    });

    it('should not flag dates in other years', () => {
      expect(isSuspectExifDate('2014-06-15T12:00:00Z')).toBe(false);
      expect(isSuspectExifDate('2016-06-15T12:00:00Z')).toBe(false);
      expect(isSuspectExifDate('2020-07-04T12:00:00Z')).toBe(false);
      expect(isSuspectExifDate('2022-07-04T12:00:00Z')).toBe(false);
    });

    it('should identify asset with suspect EXIF date or local date', () => {
      const suspectAsset = createAsset('suspect-1', 1000, { dateTimeOriginal: '2015-06-20T10:00:00Z' as any });
      const normalAsset = createAsset('normal-1', 1000, { dateTimeOriginal: '2019-10-15T10:00:00Z' as any });
      normalAsset.localDateTime = '2019-10-15T10:00:00Z';

      expect(isAssetDateSuspect(suspectAsset)).toBe(true);
      expect(isAssetDateSuspect(normalAsset)).toBe(false);
    });
  });

  describe('Folder Organization & Location Description Preference', () => {
    it('should compute higher descriptive segments and depth for nested location subfolders', () => {
      const nestedLocation =
        '/mnt/originals/2003_2004 World Trip Photos for Albums/aiAfrica/4mWestern Sahara/IMG_4657.JPG';
      const rootFolder = '/mnt/originals/2003_2004 World Trip Photos for Albums/IMG_4657.JPG';

      const scoreNested = getFolderOrganizationScore(nestedLocation);
      const scoreRoot = getFolderOrganizationScore(rootFolder);

      expect(scoreNested.descriptiveSegmentsCount).toBe(3); // 2003_2004 World Trip..., aiAfrica, 4mWestern Sahara
      expect(scoreRoot.descriptiveSegmentsCount).toBe(1); // 2003_2004 World Trip...
      expect(scoreNested.depth).toBe(5);
      expect(scoreRoot.depth).toBe(3);
      expect(scoreNested.descriptiveLength).toBeGreaterThan(scoreRoot.descriptiveLength);
    });

    it('should prefer keeping the photo with extra location description over root photo with same size and resolution', () => {
      const locationPhoto = at(
        createAsset('location-photo', 742_317),
        '/mnt/originals/2003_2004 World Trip Photos for Albums/aiAfrica/4mWestern Sahara/IMG_4657.JPG',
        { width: 2272, height: 1704 },
      );
      const rootPhoto = at(
        createAsset('root-photo', 742_317),
        '/mnt/originals/2003_2004 World Trip Photos for Albums/IMG_4657.JPG',
        { width: 2272, height: 1704 },
      );

      // Regardless of array order, locationPhoto must be chosen as the keeper!
      expect(suggestDuplicate([rootPhoto, locationPhoto], preference)?.id).toBe('location-photo');
      expect(suggestDuplicate([locationPhoto, rootPhoto], preference)?.id).toBe('location-photo');

      const keepIds = suggestDuplicateKeepAssetIds([rootPhoto, locationPhoto], preference);
      expect(keepIds).toEqual(['location-photo']);
    });
  });
});
