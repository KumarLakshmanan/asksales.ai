import { getActiveAdminCredential, getAllActiveAdminCredentials } from '../../models/adminApiCredentials/functions.js';
import { loadVertexServiceAccount } from '../../utils/vertexAuth.js';
import { logger } from '../../utils/logger.js';
import {
  GEMINI_IMAGE_MODEL,
  GEMINI_VIDEO_MODEL,
  VALID_IMAGE_MODELS,
  VALID_VIDEO_MODELS,
} from '../../utils/llmConstants.js';
import { GOOGLE_IMAGE_ASPECT_RATIOS, type ImageCapabilities } from '../../../shared/imageSettings.js';

export type MediaProviderId = 'google' | 'openrouter';
export type MediaKind = 'image' | 'video';

export interface MediaProviderSelection {
  provider: MediaProviderId;
  model: string;
}

export interface MediaModelOption {
  id: string;
  name: string;
  description?: string;
  capabilities: {
    inputModalities?: string[];
    outputModalities?: string[];
    aspectRatios?: string[];
    durations?: number[];
    resolutions?: string[];
    frameImages?: string[];
    supportsImageReferences?: boolean;
    supportsAudio?: boolean;
    supportsSeed?: boolean;
    maxOutputs?: number;
  };
}

export interface MediaProviderOption {
  id: MediaProviderId;
  label: string;
  configured: boolean;
  models: MediaModelOption[];
}

export interface MediaProviderCatalog {
  image: MediaProviderOption[];
  video: MediaProviderOption[];
  defaults: {
    image: MediaProviderSelection;
    video: MediaProviderSelection;
  };
  refreshedAt: string;
}

export const DEFAULT_IMAGE_SELECTION: MediaProviderSelection = {
  provider: 'google',
  model: GEMINI_IMAGE_MODEL,
};

export const DEFAULT_VIDEO_SELECTION: MediaProviderSelection = {
  provider: 'google',
  model: GEMINI_VIDEO_MODEL,
};

export const DEFAULT_OPENROUTER_IMAGE_MODEL = 'bytedance-seed/seedream-5-0-pro';
export const DEFAULT_OPENROUTER_VIDEO_MODEL = 'bytedance/seedance-2.5';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const CACHE_TTL_MS = 15 * 60 * 1000;

const GOOGLE_IMAGE_MODELS: MediaModelOption[] = VALID_IMAGE_MODELS.map((id) => ({
  id,
  name: id === GEMINI_IMAGE_MODEL ? 'Gemini 2.5 Flash Image' : id,
  capabilities: {
    inputModalities: ['text', 'image'],
    outputModalities: ['image'],
    // The Google worker sends only aspectRatio; it never sends imageSize, so
    // Gemini returns its default 1K output whatever size the UI requests.
    aspectRatios: [...GOOGLE_IMAGE_ASPECT_RATIOS],
    resolutions: ['1K'],
    supportsImageReferences: true,
    supportsSeed: true,
    maxOutputs: 1,
  },
}));

const GOOGLE_VIDEO_MODELS: MediaModelOption[] = VALID_VIDEO_MODELS.map((id) => ({
  id,
  name: id.includes('fast') ? 'Veo 3.1 Fast' : 'Veo 3.1',
  capabilities: {
    inputModalities: ['text', 'image'],
    outputModalities: ['video'],
    aspectRatios: ['16:9', '9:16'],
    durations: [4, 6, 8],
    resolutions: ['720p', '1080p'],
    frameImages: ['first_frame'],
    supportsAudio: true,
    supportsSeed: true,
    maxOutputs: 1,
  },
}));

const FALLBACK_OPENROUTER_IMAGE_MODELS: MediaModelOption[] = [
  {
    id: DEFAULT_OPENROUTER_IMAGE_MODEL,
    name: 'ByteDance Seedream 5.0 Pro',
    capabilities: {
      inputModalities: ['text', 'image'], outputModalities: ['image'],
      aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '9:16', '16:9', '21:9'],
      resolutions: ['1K', '2K'], supportsImageReferences: true, supportsSeed: true, maxOutputs: 1,
    },
  },
  {
    id: 'bytedance-seed/seedream-5-0-lite',
    name: 'ByteDance Seedream 5.0 Lite',
    capabilities: {
      inputModalities: ['text', 'image'], outputModalities: ['image'],
      aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '9:16', '16:9', '21:9'],
      resolutions: ['2K', '4K'], supportsImageReferences: true, supportsSeed: true, maxOutputs: 4,
    },
  },
  {
    id: 'openai/gpt-image-2',
    name: 'OpenAI GPT Image 2',
    capabilities: {
      inputModalities: ['text', 'image'], outputModalities: ['image'],
      aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'],
      supportsImageReferences: true, maxOutputs: 10,
    },
  },
  {
    id: 'google/gemini-3.1-flash-image',
    name: 'Google Gemini 3.1 Flash Image',
    capabilities: {
      inputModalities: ['text', 'image'], outputModalities: ['image', 'text'],
      aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '9:16', '16:9', '21:9'],
      resolutions: ['512', '1K', '2K', '4K'], supportsImageReferences: true, maxOutputs: 1,
    },
  },
];

const FALLBACK_OPENROUTER_VIDEO_MODELS: MediaModelOption[] = [
  {
    id: DEFAULT_OPENROUTER_VIDEO_MODEL,
    name: 'ByteDance Seedance 2.5',
    capabilities: {
      inputModalities: ['text', 'image'], outputModalities: ['video'],
      aspectRatios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'],
      durations: Array.from({ length: 27 }, (_, index) => index + 4),
      resolutions: ['480p', '720p'], frameImages: ['first_frame', 'last_frame'],
      supportsAudio: true, supportsSeed: true, maxOutputs: 1,
    },
  },
  {
    id: 'bytedance/seedance-2.0-fast',
    name: 'ByteDance Seedance 2.0 Fast',
    capabilities: {
      inputModalities: ['text', 'image'], outputModalities: ['video'],
      aspectRatios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'],
      durations: Array.from({ length: 12 }, (_, index) => index + 4),
      resolutions: ['480p', '720p'], frameImages: ['first_frame', 'last_frame'],
      supportsAudio: true, supportsSeed: true, maxOutputs: 1,
    },
  },
  {
    id: 'bytedance/seedance-2.0',
    name: 'ByteDance Seedance 2.0',
    capabilities: {
      inputModalities: ['text', 'image'], outputModalities: ['video'],
      aspectRatios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'],
      durations: Array.from({ length: 12 }, (_, index) => index + 4),
      resolutions: ['480p', '720p', '1080p', '4K'], frameImages: ['first_frame', 'last_frame'],
      supportsAudio: true, supportsSeed: true, maxOutputs: 1,
    },
  },
  {
    id: 'kwaivgi/kling-v3.0-std',
    name: 'Kling Video v3.0 Standard',
    capabilities: {
      inputModalities: ['text', 'image'], outputModalities: ['video'],
      aspectRatios: ['1:1', '9:16', '16:9'], durations: Array.from({ length: 13 }, (_, index) => index + 3),
      resolutions: ['720p'], frameImages: ['first_frame', 'last_frame'], supportsAudio: true, maxOutputs: 1,
    },
  },
  {
    id: 'google/veo-3.1-fast',
    name: 'Google Veo 3.1 Fast via OpenRouter',
    capabilities: {
      inputModalities: ['text', 'image'], outputModalities: ['video'], aspectRatios: ['9:16', '16:9'],
      durations: [4, 6, 8], resolutions: ['720p', '1080p', '4K'], frameImages: ['first_frame', 'last_frame'],
      supportsAudio: true, supportsSeed: true, maxOutputs: 1,
    },
  },
];

type OpenRouterCapabilityDescriptor = {
  type?: 'enum' | 'range' | 'boolean';
  values?: unknown[];
  min?: number;
  max?: number;
};

interface OpenRouterImageModel {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
  supported_parameters?: Record<string, OpenRouterCapabilityDescriptor>;
}

interface OpenRouterVideoModel {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  supported_aspect_ratios?: unknown;
  supported_durations?: unknown;
  supported_resolutions?: unknown;
  supported_frame_images?: unknown;
  generate_audio?: unknown;
  seed?: unknown;
}

let openRouterCache: { image: MediaModelOption[]; video: MediaModelOption[]; expiresAt: number } | null = null;

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((entry): entry is string => typeof entry === 'string' && entry.length <= 100);
  return values.length > 0 ? values : undefined;
}

function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((entry): entry is number => Number.isInteger(entry) && entry > 0 && entry <= 120);
  return values.length > 0 ? values : undefined;
}

function enumValues(descriptor: OpenRouterCapabilityDescriptor | undefined): string[] | undefined {
  return descriptor?.type === 'enum' ? stringArray(descriptor.values) : undefined;
}

function maxOutputs(descriptor: OpenRouterCapabilityDescriptor | undefined): number | undefined {
  if (!descriptor) return undefined;
  if (descriptor.type === 'range' && Number.isInteger(descriptor.max)) return descriptor.max;
  return undefined;
}

async function fetchOpenRouterModels(path: string): Promise<unknown[]> {
  const response = await fetch(`${OPENROUTER_BASE_URL}${path}`, {
    signal: AbortSignal.timeout(7_000),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`OpenRouter model discovery failed (${response.status})`);
  const payload = await response.json() as { data?: unknown };
  if (!Array.isArray(payload.data)) throw new Error('OpenRouter model discovery returned an invalid response');
  return payload.data.slice(0, 250);
}

async function getOpenRouterModels(): Promise<{ image: MediaModelOption[]; video: MediaModelOption[] }> {
  if (openRouterCache && Date.now() < openRouterCache.expiresAt) return openRouterCache;
  try {
    const [rawImages, rawVideos] = await Promise.all([
      fetchOpenRouterModels('/images/models'),
      fetchOpenRouterModels('/videos/models'),
    ]);
    const image = rawImages.flatMap((raw): MediaModelOption[] => {
      const model = raw as OpenRouterImageModel;
      if (typeof model.id !== 'string' || typeof model.name !== 'string') return [];
      const params = model.supported_parameters || {};
      return [{
        id: model.id,
        name: model.name,
        description: typeof model.description === 'string' ? model.description.slice(0, 500) : undefined,
        capabilities: {
          inputModalities: stringArray(model.architecture?.input_modalities),
          outputModalities: stringArray(model.architecture?.output_modalities),
          aspectRatios: enumValues(params.aspect_ratio),
          resolutions: enumValues(params.resolution),
          supportsImageReferences: Boolean(params.input_references),
          supportsSeed: Boolean(params.seed),
          maxOutputs: maxOutputs(params.n),
        },
      }];
    });
    image.sort((left, right) => Number(right.id === DEFAULT_OPENROUTER_IMAGE_MODEL)
      - Number(left.id === DEFAULT_OPENROUTER_IMAGE_MODEL));
    const video = rawVideos.flatMap((raw): MediaModelOption[] => {
      const model = raw as OpenRouterVideoModel;
      if (typeof model.id !== 'string' || typeof model.name !== 'string') return [];
      return [{
        id: model.id,
        name: model.name,
        description: typeof model.description === 'string' ? model.description.slice(0, 500) : undefined,
        capabilities: {
          inputModalities: ['text', 'image'],
          outputModalities: ['video'],
          aspectRatios: stringArray(model.supported_aspect_ratios),
          durations: numberArray(model.supported_durations),
          resolutions: stringArray(model.supported_resolutions),
          frameImages: stringArray(model.supported_frame_images),
          supportsAudio: model.generate_audio === true,
          supportsSeed: model.seed === true,
          maxOutputs: 1,
        },
      }];
    });
    video.sort((left, right) => Number(right.id === DEFAULT_OPENROUTER_VIDEO_MODEL)
      - Number(left.id === DEFAULT_OPENROUTER_VIDEO_MODEL));
    if (image.length === 0 || video.length === 0) throw new Error('OpenRouter returned an empty media model catalog');
    openRouterCache = { image, video, expiresAt: Date.now() + CACHE_TTL_MS };
    return openRouterCache;
  } catch (error) {
    logger.warn({ err: error }, '[MediaProviderRegistry] Using fallback OpenRouter media catalog');
    return {
      image: openRouterCache?.image || FALLBACK_OPENROUTER_IMAGE_MODELS,
      video: openRouterCache?.video || FALLBACK_OPENROUTER_VIDEO_MODELS,
    };
  }
}

export async function isMediaProviderConfigured(kind: MediaKind, provider: MediaProviderId): Promise<boolean> {
  if (provider === 'openrouter') {
    return Boolean(await getActiveAdminCredential('openrouter')) || Boolean(process.env.OPENROUTER_API_KEY);
  }
  const specialized = kind === 'image' ? 'gemini_image' : 'gemini_video';
  return Boolean(await getActiveAdminCredential(specialized))
    || Boolean(await getActiveAdminCredential('gemini'))
    || Boolean(process.env.GEMINI_API_KEY)
    || Boolean(loadVertexServiceAccount());
}

export async function getMediaProviderCatalog(): Promise<MediaProviderCatalog> {
  const openrouter = await getOpenRouterModels();
  const [googleImage, googleVideo, openrouterConfigured, imageDefault, videoDefault] = await Promise.all([
    isMediaProviderConfigured('image', 'google'),
    isMediaProviderConfigured('video', 'google'),
    isMediaProviderConfigured('image', 'openrouter'),
    mediaSelectionFromIntegrations('image'),
    mediaSelectionFromIntegrations('video'),
  ]);
  return {
    image: [
      { id: 'google', label: 'Google Gemini / Vertex AI', configured: googleImage, models: GOOGLE_IMAGE_MODELS },
      { id: 'openrouter', label: 'OpenRouter', configured: openrouterConfigured, models: openrouter.image },
    ],
    video: [
      { id: 'google', label: 'Google Veo / Vertex AI', configured: googleVideo, models: GOOGLE_VIDEO_MODELS },
      { id: 'openrouter', label: 'OpenRouter', configured: openrouterConfigured, models: openrouter.video },
    ],
    defaults: { image: imageDefault, video: videoDefault },
    refreshedAt: new Date().toISOString(),
  };
}

/**
 * Capabilities of one image model, from the live OpenRouter catalog (falling
 * back to the built-in list). Unknown models return {} so nothing is rewritten.
 */
export async function getImageModelCapabilities(selection: MediaProviderSelection): Promise<ImageCapabilities> {
  const models = selection.provider === 'google' ? GOOGLE_IMAGE_MODELS : (await getOpenRouterModels()).image;
  const capabilities = models.find((model) => model.id === selection.model)?.capabilities;
  return capabilities ? { aspectRatios: capabilities.aspectRatios, resolutions: capabilities.resolutions } : {};
}

function normalizeProvider(value: unknown): MediaProviderId | undefined {
  return value === 'google' || value === 'openrouter' ? value : undefined;
}

export async function resolveMediaProviderSelection(
  kind: MediaKind,
  _userId?: number,
  _explicit?: Partial<MediaProviderSelection>,
): Promise<MediaProviderSelection> {
  return mediaSelectionFromIntegrations(kind);
}

/** Only already-active, admin-managed integrations may receive a failed image request. */
export async function resolveImageAuthenticationFallback(excluded: MediaProviderId): Promise<MediaProviderSelection | null> {
  if (excluded === 'google') {
    const credential = await getActiveAdminCredential('openrouter');
    if (!credential?.apiKey) return null;
    const configured = credential.config?.imageModel;
    return { provider: 'openrouter', model: typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_OPENROUTER_IMAGE_MODEL };
  }
  const credential = await getActiveAdminCredential('gemini_image') || await getActiveAdminCredential('gemini');
  if (!credential?.apiKey) return null;
  const configured = credential.config?.model;
  return { provider: 'google', model: typeof configured === 'string' && VALID_IMAGE_MODELS.includes(configured) ? configured : DEFAULT_IMAGE_SELECTION.model };
}

async function mediaSelectionFromIntegrations(kind: MediaKind): Promise<MediaProviderSelection> {
  const specialized = kind === 'image' ? 'gemini_image' : 'gemini_video';
  const groups = await Promise.all([getAllActiveAdminCredentials(specialized),
    getAllActiveAdminCredentials('openrouter'), getAllActiveAdminCredentials('gemini')]);
  const candidates = groups.flatMap((rows, group) => rows.map(row => ({ row, group })));
  const priority = { high: 0, normal: 1, low: 2, fallback: 3 } as Record<string, number>;
  candidates.sort((a, b) => (priority[a.row.priority] ?? 4) - (priority[b.row.priority] ?? 4)
    || a.group - b.group || a.row.id - b.row.id);
  for (const { row, group } of candidates) {
    const config = row.config || {};
    const configuredModel = group === 0 ? config.model : config[kind === 'image' ? 'imageModel' : 'videoModel'];
    const model = typeof configuredModel === 'string' && configuredModel.trim() ? configuredModel.trim()
      : group === 1 ? kind === 'image' ? DEFAULT_OPENROUTER_IMAGE_MODEL : DEFAULT_OPENROUTER_VIDEO_MODEL
        : kind === 'image' ? DEFAULT_IMAGE_SELECTION.model : DEFAULT_VIDEO_SELECTION.model;
    if (row.apiKey) {
      // Match the supported image catalog, including older saved integrations.
      // Passing an invalid saved model as an explicit worker override bypasses
      // the worker's normal fallback and sends an unusable model to Google.
      if (kind === 'image' && group !== 1 && !VALID_IMAGE_MODELS.includes(model)) {
        logger.warn({ credentialId: row.id, model, fallback: DEFAULT_IMAGE_SELECTION.model }, 'Using the supported Google image model for a legacy integration');
        return { ...DEFAULT_IMAGE_SELECTION };
      }
      return { provider: group === 1 ? 'openrouter' : 'google', model };
    }
  }
  return kind === 'image' ? DEFAULT_IMAGE_SELECTION : DEFAULT_VIDEO_SELECTION;
}

export async function assertValidMediaSelection(
  kind: MediaKind,
  selection: Partial<MediaProviderSelection>,
  options: { requireConfigured?: boolean; allowUnavailableModel?: boolean } = {},
): Promise<MediaProviderSelection> {
  const provider = normalizeProvider(selection.provider);
  const model = String(selection.model || '').trim();
  if (!provider || !model || model.length > 200) throw new Error(`Select a valid ${kind} provider and model`);
  const catalog = await getMediaProviderCatalog();
  const providerOption = catalog[kind].find((entry) => entry.id === provider);
  if (!providerOption) throw new Error(`Select a valid ${kind} provider and model`);
  if (!providerOption.models.some((entry) => entry.id === model) && options.allowUnavailableModel !== true) {
    throw new Error(`The selected ${kind} model is not available from ${provider}`);
  }
  if (options.requireConfigured !== false && !providerOption.configured) {
    throw new Error(`${providerOption.label} is not configured for ${kind} generation`);
  }
  return { provider, model };
}
