/**
 * Content Executor Tests
 * Tests: placeholder image guard, content asset saving logic
 * 
 * Logic replicated from: mastra/tools/executors/contentExecutor.ts
 */
import { describe, it, expect } from '@jest/globals';

// ─── Replicated logic from contentExecutor.ts ────────────────────────────────

interface GeneratedImage {
  imageData?: string;
  mimeType?: string;
  placeholder?: boolean;
  message?: string;
}

interface GeneratedVideo {
  videoData?: string;
  videoUrl?: string;
  mimeType?: string;
  placeholder?: boolean;
  message?: string;
}

/**
 * Determines if an image should be saved to the database.
 * Placeholder images should NOT be saved.
 */
function shouldSaveImage(image: GeneratedImage | null | undefined): boolean {
  if (!image) return false;
  if (!image.imageData) return false;
  if (image.placeholder) return false;
  return true;
}

/**
 * Determines if a video should be saved to the database.
 * Placeholder videos should NOT be saved.
 */
function shouldSaveVideo(video: GeneratedVideo | null | undefined): boolean {
  if (!video) return false;
  if (!video.videoUrl && !video.videoData) return false;
  if (video.placeholder) return false;
  return true;
}

/**
 * Builds the image URL for the DM template content.
 * Returns undefined if the image is a placeholder (should not be stored).
 */
function buildDmImageUrl(image: GeneratedImage | null | undefined): string | undefined {
  if (!image?.imageData || image.placeholder) return undefined;
  return `data:${image.mimeType || 'image/png'};base64,${image.imageData}`;
}

/**
 * Builds the video URL for the DM template content.
 * Returns undefined if the video is a placeholder (should not be stored).
 */
function buildDmVideoUrl(video: GeneratedVideo | null | undefined): string | undefined {
  if (!video) return undefined;
  if (video.placeholder) return undefined;
  if (!video.videoUrl && !video.videoData) return undefined;
  return `data:${video.mimeType || 'video/mp4'};base64,${video.videoData || ''}`;
}

/**
 * Determines if the child asset should be saved.
 */
function shouldSaveChildAsset(
  image: GeneratedImage | null | undefined,
  parentAssetId: number | undefined
): boolean {
  if (!parentAssetId) return false;
  return shouldSaveImage(image);
}

/**
 * Creates a placeholder image data URI.
 */
function createPlaceholderImageData(isRateLimit: boolean): string {
  const text = isRateLimit
    ? '⏳ Image generation temporarily unavailable'
    : '⚠️ Image generation failed';
  const subtext = isRateLimit
    ? 'API rate limit reached - please try again later'
    : 'Please try again';

  return 'data:image/svg+xml;base64,' + Buffer.from(`
    <svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#f0f0f0"/>
      <text x="50%" y="45%" font-family="Arial" font-size="16" text-anchor="middle" fill="#666">
        ${text}
      </text>
      <text x="50%" y="55%" font-family="Arial" font-size="12" text-anchor="middle" fill="#888">
        ${subtext}
      </text>
    </svg>
  `).toString('base64');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Content Executor', () => {
  describe('shouldSaveImage', () => {
    it('should return true for valid image data', () => {
      expect(shouldSaveImage({ imageData: 'base64data', mimeType: 'image/png' })).toBe(true);
    });

    it('should return false for placeholder images', () => {
      expect(shouldSaveImage({ imageData: 'base64data', placeholder: true })).toBe(false);
    });

    it('should return false for null image', () => {
      expect(shouldSaveImage(null)).toBe(false);
    });

    it('should return false for undefined image', () => {
      expect(shouldSaveImage(undefined)).toBe(false);
    });

    it('should return false when imageData is missing', () => {
      expect(shouldSaveImage({ mimeType: 'image/png' })).toBe(false);
    });

    it('should return true when placeholder is explicitly false', () => {
      expect(shouldSaveImage({ imageData: 'data', placeholder: false })).toBe(true);
    });
  });

  describe('shouldSaveVideo', () => {
    it('should return true for valid video URL', () => {
      expect(shouldSaveVideo({ videoUrl: 'https://example.com/video.mp4' })).toBe(true);
    });

    it('should return true for valid video data', () => {
      expect(shouldSaveVideo({ videoData: 'base64data' })).toBe(true);
    });

    it('should return false for placeholder videos', () => {
      expect(shouldSaveVideo({ videoUrl: 'https://example.com/video.mp4', placeholder: true })).toBe(false);
    });

    it('should return false for null video', () => {
      expect(shouldSaveVideo(null)).toBe(false);
    });

    it('should return false for empty video', () => {
      expect(shouldSaveVideo({})).toBe(false);
    });
  });

  describe('buildDmImageUrl', () => {
    it('should build data URL for valid image', () => {
      const url = buildDmImageUrl({ imageData: 'abc123', mimeType: 'image/png' });
      expect(url).toBe('data:image/png;base64,abc123');
    });

    it('should use default mime type', () => {
      const url = buildDmImageUrl({ imageData: 'abc123' });
      expect(url).toBe('data:image/png;base64,abc123');
    });

    it('should return undefined for placeholder image', () => {
      const url = buildDmImageUrl({ imageData: 'abc123', placeholder: true });
      expect(url).toBeUndefined();
    });

    it('should return undefined for null image', () => {
      expect(buildDmImageUrl(null)).toBeUndefined();
    });

    it('should return undefined when imageData is missing', () => {
      expect(buildDmImageUrl({ mimeType: 'image/png' })).toBeUndefined();
    });
  });

  describe('buildDmVideoUrl', () => {
    it('should build data URL for valid video', () => {
      const url = buildDmVideoUrl({ videoData: 'abc123', mimeType: 'video/mp4' });
      expect(url).toBe('data:video/mp4;base64,abc123');
    });

    it('should return undefined for placeholder video', () => {
      const url = buildDmVideoUrl({ videoData: 'abc123', placeholder: true });
      expect(url).toBeUndefined();
    });

    it('should return undefined for null video', () => {
      expect(buildDmVideoUrl(null)).toBeUndefined();
    });
  });

  describe('shouldSaveChildAsset', () => {
    it('should return true for valid image with parent ID', () => {
      const image = { imageData: 'base64data', mimeType: 'image/png' };
      expect(shouldSaveChildAsset(image, 123)).toBe(true);
    });

    it('should return false for placeholder image', () => {
      const image = { imageData: 'base64data', placeholder: true };
      expect(shouldSaveChildAsset(image, 123)).toBe(false);
    });

    it('should return false when parentAssetId is undefined', () => {
      const image = { imageData: 'base64data' };
      expect(shouldSaveChildAsset(image, undefined)).toBe(false);
    });

    it('should return false when image is null', () => {
      expect(shouldSaveChildAsset(null, 123)).toBe(false);
    });
  });

  describe('createPlaceholderImageData', () => {
    it('should return a base64 data URI', () => {
      const data = createPlaceholderImageData(false);
      expect(data).toMatch(/^data:image\/svg\+xml;base64,/);
    });

    it('should contain rate limit message for rate limit errors', () => {
      const data = createPlaceholderImageData(true);
      const decoded = Buffer.from(data.split(',')[1], 'base64').toString();
      expect(decoded).toContain('rate limit');
    });

    it('should contain generic failure message for non-rate-limit errors', () => {
      const data = createPlaceholderImageData(false);
      const decoded = Buffer.from(data.split(',')[1], 'base64').toString();
      expect(decoded).toContain('generation failed');
    });

    it('should produce valid SVG', () => {
      const data = createPlaceholderImageData(false);
      const svg = Buffer.from(data.split(',')[1], 'base64').toString();
      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    });
  });
});
