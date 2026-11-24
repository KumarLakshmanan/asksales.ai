import { prepareVideoSettings, validateVideoSettings, type VideoCapabilities } from '../../../shared/videoSettings.js';
import { getMediaProviderCatalog, resolveMediaProviderSelection } from './MediaProviderRegistry.js';

async function selectedVideoCapabilities(userId?: number) {
  const selection = await resolveMediaProviderSelection('video', userId);
  const catalog = await getMediaProviderCatalog();
  const capabilities: VideoCapabilities = catalog.video.find(provider => provider.id === selection.provider)?.models.find(model => model.id === selection.model)?.capabilities || {};
  return { selection, capabilities };
}

export async function prepareVideoReview(values: Record<string, unknown>, userId?: number) {
  const { selection, capabilities } = await selectedVideoCapabilities(userId);
  const prepared = prepareVideoSettings(values, capabilities, selection.provider === 'google');
  const adjusted = ['resolution', 'duration_seconds', 'aspect_ratio', 'number_of_videos'].some(key => values[key] != null && values[key] !== prepared[key as keyof typeof prepared]);
  return { ...prepared, ...selection, video_capabilities: capabilities,
    ...(adjusted ? { video_settings_note: 'The proposed settings were adjusted to supported values. Review them before generating.' } : {}),
  };
}

export async function assertValidVideoReview(values: Record<string, unknown>, userId?: number) {
  const { selection, capabilities } = await selectedVideoCapabilities(userId);
  const error = validateVideoSettings(values, capabilities, selection.provider === 'google');
  if (error) throw new Error(error);
}
