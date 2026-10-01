import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  finalizePixelHash,
  getHammingDistance,
  getLuminanceVariance,
  hashPerceptual,
  hashPixels,
  HIGH_CONFIDENCE_MAX_DISTANCE,
  isSiblingProtected,
  MIN_LUMINANCE_VARIANCE,
  PERCEPTUAL_SAMPLE_SIZE,
  POSSIBLE_MAX_DISTANCE,
} from 'src/utils/fingerprint';
import { describe, expect, it } from 'vitest';

const SIZE = PERCEPTUAL_SAMPLE_SIZE;

/**
 * A deterministic photograph-like test image: several spatial frequencies plus hard edges, so its
 * energy is spread across the DCT coefficients the way a real photo's is. A single sinusoid or a
 * sharp repeating ramp is NOT a valid stand-in here -- nearly all of its energy lands in two or
 * three coefficients, the rest sit at noise level, and a lossless re-encode then flips a third of
 * the hash bits. That is a property of perceptual hashing, not a bug, but it makes such an image
 * useless as a fixture.
 */
const makeImage = (width: number, height: number, seed = 0) => {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const u = x / width;
      const v = y / height;
      const luminance = Math.max(
        0,
        Math.min(
          255,
          128 +
            90 * Math.sin((u * 3 + seed) * Math.PI) +
            50 * Math.cos((v * 5 + seed * 0.7) * Math.PI) +
            30 * Math.sin((u * 11 + v * 7 + seed) * Math.PI) +
            (u > 0.55 && v > 0.4 ? 45 : 0) +
            (Math.hypot(u - 0.3 - seed * 0.05, v - 0.6) < 0.15 ? -55 : 0),
        ),
      );
      data[offset] = luminance;
      data[offset + 1] = luminance;
      data[offset + 2] = luminance;
    }
  }
  return { data, width, height, channels: 3 };
};

/** Render the same picture through a real encoder, then sample it exactly as the service does. */
const sampleThroughEncoder = async (source: ReturnType<typeof makeImage>, format: 'png' | 'jpeg', quality = 90) => {
  const encoded = await sharp(source.data, {
    raw: { width: source.width, height: source.height, channels: 3 },
  })
    .toFormat(format, format === 'jpeg' ? { quality } : {})
    .toBuffer();

  const { data, info } = await sharp(encoded)
    .resize(SIZE, SIZE, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, width: info.width, height: info.height, channels: info.channels };
};

describe('fingerprint', () => {
  describe('hashPixels', () => {
    it('should be stable for the same pixels', () => {
      const image = makeImage(16, 16);
      expect(hashPixels(image)).toEqual(hashPixels(makeImage(16, 16)));
    });

    it('should differ when a single pixel changes', () => {
      const a = makeImage(16, 16);
      const b = makeImage(16, 16);
      b.data[0] ^= 0xff;
      expect(hashPixels(a)).not.toEqual(hashPixels(b));
    });

    it('should agree with the streamed digest path', () => {
      // The decoder hashes pixels incrementally and folds the geometry in afterwards; the buffered
      // helper must produce the same value or a preview hash could never match a full-res one.
      const image = makeImage(16, 16);
      const streamed = finalizePixelHash({
        digest: createHash('sha256').update(image.data).digest(),
        width: image.width,
        height: image.height,
        channels: image.channels,
      });
      expect(hashPixels(image)).toEqual(streamed);
    });

    it('should not collide when the same bytes are reinterpreted with different geometry', () => {
      const wide = { data: Buffer.alloc(48, 7), width: 4, height: 4, channels: 3 };
      const tall = { data: Buffer.alloc(48, 7), width: 2, height: 8, channels: 3 };
      expect(hashPixels(wide)).not.toEqual(hashPixels(tall));
    });
  });

  describe('hashPerceptual', () => {
    it('should reject a sample that is not an exact square', () => {
      expect(() => hashPerceptual({ data: Buffer.alloc(43 * SIZE), width: 43, height: SIZE, channels: 1 })).toThrow();
    });

    it('should return null for a flat, low-information image', () => {
      const flat = { data: Buffer.alloc(SIZE * SIZE, 128), width: SIZE, height: SIZE, channels: 1 };
      expect(getLuminanceVariance(Float64Array.from(flat.data))).toBeLessThan(MIN_LUMINANCE_VARIANCE);
      expect(hashPerceptual(flat)).toBeNull();
    });

    it('should produce a 64-bit hash', () => {
      const hash = hashPerceptual(makeImage(SIZE, SIZE));
      expect(hash).not.toBeNull();
      expect(hash!.length).toBe(8);
    });

    it('should survive a real JPEG re-encode of the same picture', async () => {
      // This is the actual case: a Google Takeout copy is the same photo, re-encoded.
      const source = makeImage(256, 256);
      const original = hashPerceptual(await sampleThroughEncoder(source, 'png'));
      expect(original).not.toBeNull();

      for (const quality of [95, 85, 70, 50]) {
        const recompressed = hashPerceptual(await sampleThroughEncoder(source, 'jpeg', quality));
        expect(getHammingDistance(original!, recompressed!)).toBeLessThanOrEqual(HIGH_CONFIDENCE_MAX_DISTANCE);
      }
    });

    it('should survive a 2x downscale of the same picture', async () => {
      const source = makeImage(256, 256);
      const original = hashPerceptual(await sampleThroughEncoder(source, 'png'))!;
      const halved = hashPerceptual(await sampleThroughEncoder(makeImage(128, 128), 'jpeg', 85))!;
      expect(getHammingDistance(original, halved)).toBeLessThanOrEqual(HIGH_CONFIDENCE_MAX_DISTANCE);
    });

    it('should separate two genuinely different pictures', async () => {
      const a = hashPerceptual(await sampleThroughEncoder(makeImage(256, 256), 'png'));
      const b = hashPerceptual(await sampleThroughEncoder(makeImage(256, 256, 0.5), 'png'));
      expect(getHammingDistance(a!, b!)).toBeGreaterThan(POSSIBLE_MAX_DISTANCE);
    });
  });

  describe('getHammingDistance', () => {
    it('should be 0 for identical hashes', () => {
      expect(getHammingDistance(Buffer.from([0b1010_1010]), Buffer.from([0b1010_1010]))).toBe(0);
    });

    it('should count differing bits', () => {
      expect(getHammingDistance(Buffer.from([0b0000_0000]), Buffer.from([0b0000_0111]))).toBe(3);
    });

    it('should refuse to compare hashes of different lengths', () => {
      expect(getHammingDistance(Buffer.alloc(8), Buffer.alloc(4))).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('isSiblingProtected', () => {
    it.each([
      ['IMG_1234 (edited).jpg', true],
      ['IMG_1234_BURST001.jpg', true],
      ['IMG_1234-cropped.jpg', true],
      ['IMG_1234.jpg', false],
      ['20240101_edited_by_nobody.jpg', true],
      ['Editorial.jpg', false],
    ])('should treat %s as protected=%s', (fileName, expected) => {
      expect(isSiblingProtected({ fileName, isEdited: false })).toBe(expected);
    });

    it('should honour the asset flag regardless of filename', () => {
      expect(isSiblingProtected({ fileName: 'IMG_1234.jpg', isEdited: true })).toBe(true);
    });
  });
});
