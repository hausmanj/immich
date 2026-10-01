import { createHash } from 'node:crypto';

/**
 * Content fingerprints for duplicate detection, ported from immich-go `internal/duplicates`
 * (`image.go`, `model.go`; 2026-09-09). A perceptual match is never proof that an original is
 * expendable -- only {@link hashPixels} equality is.
 *
 * Bump this whenever any hash below changes shape or meaning: `asset_fingerprint` rows carrying an
 * older version are recomputed rather than silently compared against incompatible values.
 */
// v3: videos now use a complete-file SHA-256 in contentHash; image hashes remain the streamed pixel
// digest with geometry folded
// in afterwards, rather than over a single buffered header+pixels blob. Same inputs, different
// value, so v1 rows must be recomputed rather than compared against v2 ones.
export const FINGERPRINT_ALGORITHM_VERSION = 3;

/** 32x32 luminance sample feeding the DCT, per the immich-go spec. */
export const PERCEPTUAL_SAMPLE_SIZE = 32;

/** Luminance variance below this carries too little information to corroborate a match. */
export const MIN_LUMINANCE_VARIANCE = 25;

/** Hamming distance at or below this is a possible perceptual match. */
export const POSSIBLE_MAX_DISTANCE = 6;

/** Hamming distance at or below this, with corroborating metadata, is a high-confidence match. */
export const HIGH_CONFIDENCE_MAX_DISTANCE = 3;

/** Aspect ratios must agree within this fraction before a perceptual match is considered. */
export const MAX_ASPECT_RATIO_DIFFERENCE = 0.01;

/** High confidence additionally requires known capture times within this many milliseconds. */
export const MAX_CAPTURE_TIME_DIFFERENCE_MS = 2000;

/** High confidence additionally requires each smaller dimension to be at least this share of the larger. */
export const MIN_DIMENSION_RATIO = 0.5;

/** Fractions of a video's duration sampled for fingerprinting, per the immich-go spec. */
export const VIDEO_SAMPLE_POINTS = [0.1, 0.3, 0.5, 0.7, 0.9] as const;

/** Durations must agree within max(0.25s, this fraction of the shorter clip). */
export const VIDEO_DURATION_TOLERANCE = 0.005;
export const VIDEO_MIN_DURATION_TOLERANCE_MS = 250;

/** Average frame rates must agree within this fraction. */
export const MAX_FRAME_RATE_DIFFERENCE = 0.02;

/**
 * Combines the per-frame digests of a sampled video into one comparable value.
 *
 * Deliberately excludes duration and frame rate: those are compared separately with a tolerance,
 * and folding them into an equality hash would make a container remux look like a different video.
 */
export const hashVideoFrames = (frameDigests: Buffer[]): Buffer => {
  const hash = createHash('sha256');
  for (const digest of frameDigests) {
    hash.update(digest);
  }
  return hash.digest();
};

export const durationsMatch = (a: number, b: number): boolean => {
  const tolerance = Math.max(VIDEO_MIN_DURATION_TOLERANCE_MS, Math.min(a, b) * VIDEO_DURATION_TOLERANCE);
  return Math.abs(a - b) <= tolerance;
};

export const frameRatesMatch = (a: number | null, b: number | null): boolean => {
  if (!a || !b) {
    // An unknown frame rate is not evidence of a mismatch; the frame hashes still have to agree.
    return true;
  }
  return Math.abs(a / b - 1) <= MAX_FRAME_RATE_DIFFERENCE;
};

/**
 * Identity hash over decoded pixels.
 *
 * Dimensions and channel count are folded in so that two buffers of equal length but different
 * geometry cannot collide. Non-rendering EXIF metadata is deliberately absent: a Google Takeout copy
 * that dropped the maker notes is still the same picture.
 *
 * **ICC note, differing from immich-go:** the Go version keeps ICC and gamma chunks inside the
 * identity key. Here the pixels arrive from Sharp's pipeline, which has already normalized to the
 * configured working colorspace, so two files whose embedded profiles differ but whose rendered
 * pixels match will hash the same. That is the looser of the two definitions, and it is the right
 * one for this library: re-encoding through an export pipeline routinely rewrites the profile.
 */
export const hashPixels = ({
  data,
  width,
  height,
  channels,
}: {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}): Buffer => finalizePixelHash({ digest: createHash('sha256').update(data).digest(), width, height, channels });

/**
 * Folds the geometry into a digest already taken over the pixel stream.
 *
 * The decoder hashes pixels incrementally rather than buffering a whole original, so the dimensions
 * are only known once the stream has finished; they are mixed in here instead of up front. Both
 * this and {@link hashPixels} must stay in agreement -- they are compared against each other.
 */
export const finalizePixelHash = ({
  digest,
  width,
  height,
  channels,
}: {
  digest: Buffer;
  width: number;
  height: number;
  channels: number;
}): Buffer => {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt32BE(channels, 8);
  return createHash('sha256').update(digest).update(header).digest();
};

const COS_TABLE = (() => {
  const table = new Float64Array(PERCEPTUAL_SAMPLE_SIZE * PERCEPTUAL_SAMPLE_SIZE);
  for (let x = 0; x < PERCEPTUAL_SAMPLE_SIZE; x++) {
    for (let u = 0; u < PERCEPTUAL_SAMPLE_SIZE; u++) {
      table[x * PERCEPTUAL_SAMPLE_SIZE + u] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PERCEPTUAL_SAMPLE_SIZE));
    }
  }
  return table;
})();

/** Rec. 601 luma, matching the weighting the Go implementation uses. */
const toLuminance = (data: Buffer, pixelCount: number, channels: number): Float64Array => {
  const luminance = new Float64Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const offset = i * channels;
    luminance[i] =
      channels >= 3 ? 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2] : data[offset];
  }
  return luminance;
};

export const getLuminanceVariance = (luminance: Float64Array): number => {
  let sum = 0;
  for (const value of luminance) {
    sum += value;
  }
  const mean = sum / luminance.length;

  let variance = 0;
  for (const value of luminance) {
    variance += (value - mean) ** 2;
  }
  return variance / luminance.length;
};

/**
 * 64-bit DCT perceptual hash: 32x32 luminance, low-frequency 8x8 block, median threshold, DC
 * excluded (63 meaningful bits). Returns null when the image carries too little information for the
 * result to mean anything.
 *
 * Measured behaviour on broadband (photograph-like) content: distance 0 across JPEG q95 down to
 * q50 and across a 2x downscale, 12-26 between different pictures. **But the variance floor is not
 * a sufficient guard on its own** -- a smooth, low-detail image can clear it while still putting
 * almost all of its energy in two or three coefficients, leaving the remaining bits at noise level
 * and the hash unstable. That is why the classifier never promotes on perceptual distance alone.
 *
 * The input must be exactly {@link PERCEPTUAL_SAMPLE_SIZE} square. A "fit inside" resize returns
 * 43x32 for a 4:3 photo, and hashes of differently-shaped samples are not comparable.
 */
export const hashPerceptual = ({
  data,
  width,
  height,
  channels,
}: {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}): Buffer | null => {
  if (width !== PERCEPTUAL_SAMPLE_SIZE || height !== PERCEPTUAL_SAMPLE_SIZE) {
    throw new Error(`Perceptual hash needs a ${PERCEPTUAL_SAMPLE_SIZE}x${PERCEPTUAL_SAMPLE_SIZE} sample`);
  }

  const luminance = toLuminance(data, PERCEPTUAL_SAMPLE_SIZE * PERCEPTUAL_SAMPLE_SIZE, channels);
  if (getLuminanceVariance(luminance) < MIN_LUMINANCE_VARIANCE) {
    return null;
  }

  // Separable 2D DCT-II, keeping only the top-left 8x8 of coefficients.
  const rows = new Float64Array(PERCEPTUAL_SAMPLE_SIZE * 8);
  for (let y = 0; y < PERCEPTUAL_SAMPLE_SIZE; y++) {
    for (let u = 0; u < 8; u++) {
      let total = 0;
      for (let x = 0; x < PERCEPTUAL_SAMPLE_SIZE; x++) {
        total += luminance[y * PERCEPTUAL_SAMPLE_SIZE + x] * COS_TABLE[x * PERCEPTUAL_SAMPLE_SIZE + u];
      }
      rows[y * 8 + u] = total;
    }
  }

  const coefficients = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let total = 0;
      for (let y = 0; y < PERCEPTUAL_SAMPLE_SIZE; y++) {
        total += rows[y * 8 + u] * COS_TABLE[y * PERCEPTUAL_SAMPLE_SIZE + v];
      }
      coefficients[v * 8 + u] = total;
    }
  }

  // Median of the 63 non-DC coefficients.
  const withoutDc = [...coefficients.slice(1)].sort((a, b) => a - b);
  const median = (withoutDc[30] + withoutDc[31]) / 2;

  const hash = Buffer.alloc(8);
  for (let i = 0; i < 64; i++) {
    if (i !== 0 && coefficients[i] > median) {
      hash[i >> 3] |= 0b1000_0000 >> (i % 8);
    }
  }
  return hash;
};

const BIT_COUNTS = Uint8Array.from({ length: 256 }, (_, index) => {
  let count = 0;
  for (let value = index; value > 0; value >>= 1) {
    count += value & 1;
  }
  return count;
});

export const getHammingDistance = (a: Buffer, b: Buffer): number => {
  if (a.length !== b.length) {
    return Number.MAX_SAFE_INTEGER;
  }

  let distance = 0;
  for (const [index, byte] of a.entries()) {
    distance += BIT_COUNTS[byte ^ b[index]];
  }
  return distance;
};

/**
 * Explicit burst/edit markers. A sibling frame from a burst is a different picture that happens to
 * look almost identical, so it must never reach high confidence.
 */
const EDITED_MARKER = /(^|[\s_().-])(edited|edit|cropped|filtered)([\s_().-]|$)/i;
// Deviates from immich-go, which requires a separator after "burst" and therefore misses the
// iPhone's own `IMG_1234_BURST001.jpg` naming -- the single most common burst filename there is.
const BURST_MARKER = /(^|[\s_().-])burst\d*([\s_().-]|$)/i;

export const isSiblingProtected = ({ fileName, isEdited }: { fileName: string; isEdited: boolean }): boolean =>
  isEdited || EDITED_MARKER.test(fileName) || BURST_MARKER.test(fileName);
