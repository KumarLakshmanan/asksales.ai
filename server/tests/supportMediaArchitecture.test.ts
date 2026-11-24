import fs from 'node:fs';
import path from 'node:path';
import { semanticIntent } from './helpers/supportSemanticFixture.js';
import { classifyMediaIntent } from '../services/supportMedia/MediaIntentClassifier.js';
import {
  createMediaPartIdempotencyKey,
  mediaDeliveryFailureCode,
  mediaDeliveryOutcomeIsUncertain,
} from '../services/supportMedia/SupportMediaDeliveryService.js';
import {
  buildMediaLexicalTsQuery,
  diversifyMediaCandidates,
} from '../services/supportMedia/MediaGateway.js';
import { playbookEngine } from '../services/agents/orchestration/PlaybookEngine.js';
import {
  createSupportMediaDeliveryUrl,
  verifySupportMediaDeliveryToken,
} from '../services/supportMedia/SupportMediaDeliveryUrl.js';

describe('cross-channel support media architecture', () => {
  test.each([
    ['Can you show me photos of the sanctuary villa?', undefined, 'explicit', semanticIntent('information', 'stay', { media: 'explicit' })],
    ['What does the premium room look like?', undefined, 'explicit', semanticIntent('information', 'stay', { media: 'explicit' })],
    ['Compare the club room versus the villa options', undefined, 'helpful', semanticIntent('information', 'stay', { media: 'helpful' })],
    ['Please show the currently available room options and prices for those dates.', 'availability_inquiry', 'none', semanticIntent('information', 'stay', { media: 'helpful' })],
    ['Hello', undefined, 'none', semanticIntent('other')],
    ['What is my payment status?', 'payment_inquiry', 'none', semanticIntent('information', 'stay', { media: 'explicit' })],
    ['Show me my ticket status', 'ticket_status', 'none', semanticIntent('information', 'technical_support', { media: 'explicit' })],
  ] as const)('classifies media intent safely: %s', (text, intent, expected, semanticRequest) => {
    expect(classifyMediaIntent({ text, intent, semanticRequest, helpfulEnabled: true }).intent).toBe(expected);
  });

  test('suppresses unsolicited first-touch media', () => {
    expect(classifyMediaIntent({ text: 'See our product photos', helpfulEnabled: true, outboundFirstTouch: true }).intent).toBe('none');
  });

  test('media part keys are deterministic and version/order scoped', () => {
    const base = { userId: 7, inboundId: 'wamid.1', decisionVersion: 1, assetVersion: 'sha-a', partIndex: 0, channel: 'whatsapp' };
    expect(createMediaPartIdempotencyKey(base)).toBe(createMediaPartIdempotencyKey(base));
    expect(createMediaPartIdempotencyKey(base)).not.toBe(createMediaPartIdempotencyKey({ ...base, partIndex: 1 }));
    expect(createMediaPartIdempotencyKey(base)).not.toBe(createMediaPartIdempotencyKey({ ...base, assetVersion: 'sha-b' }));
  });

  test('distinguishes confirmed provider rejection from an uncertain media outcome', () => {
    expect(mediaDeliveryOutcomeIsUncertain({ deliveryAttempted: true, outcomeUncertain: false })).toBe(false);
    expect(mediaDeliveryOutcomeIsUncertain({ deliveryAttempted: true, outcomeUncertain: true })).toBe(true);
    expect(mediaDeliveryOutcomeIsUncertain({ deliveryAttempted: true })).toBe(true);
    expect(mediaDeliveryOutcomeIsUncertain({ deliveryAttempted: false })).toBe(false);
  });

  test('classifies Meta permission and authorization failures for actionable readiness', () => {
    expect(mediaDeliveryFailureCode({ errorCode: 'META_GRAPH_3' })).toBe('PROVIDER_CAPABILITY_UNAVAILABLE');
    expect(mediaDeliveryFailureCode({ message: 'Unsupported request - method type: post' })).toBe('PROVIDER_CAPABILITY_UNAVAILABLE');
    expect(mediaDeliveryFailureCode({ errorCode: 'META_GRAPH_190' })).toBe('PROVIDER_AUTHORIZATION_INVALID');
    expect(mediaDeliveryFailureCode({ message: 'A transient provider error occurred' })).toBe('DELIVERY_FAILED');
  });

  test('creates an asset-bound, expiring support media delivery URL', () => {
    const priorAppUrl = process.env.APP_URL;
    const priorKey = process.env.SUPPORT_MEDIA_DELIVERY_HMAC_KEY;
    process.env.APP_URL = 'https://asksales.ai';
    process.env.SUPPORT_MEDIA_DELIVERY_HMAC_KEY = 'unit-test-support-media-key';
    try {
      const nowMs = Date.UTC(2026, 7, 29, 10, 0, 0);
      const checksum = 'a'.repeat(64);
      const deliveryUrl = new URL(createSupportMediaDeliveryUrl({ assetId: 41, checksum, nowMs }));
      const expiresAt = Number(deliveryUrl.searchParams.get('expires'));
      const token = String(deliveryUrl.searchParams.get('token'));
      expect(deliveryUrl.origin).toBe('https://asksales.ai');
      expect(deliveryUrl.pathname).toBe('/support-media-delivery/41/image.jpg');
      expect(verifySupportMediaDeliveryToken({ assetId: 41, checksum, expiresAt, token, nowMs })).toBe(true);
      expect(verifySupportMediaDeliveryToken({ assetId: 42, checksum, expiresAt, token, nowMs })).toBe(false);
      expect(verifySupportMediaDeliveryToken({ assetId: 41, checksum: 'b'.repeat(64), expiresAt, token, nowMs })).toBe(false);
      expect(verifySupportMediaDeliveryToken({ assetId: 41, checksum, expiresAt, token, nowMs: nowMs + 301_000 })).toBe(false);
    } finally {
      if (priorAppUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = priorAppUrl;
      if (priorKey === undefined) delete process.env.SUPPORT_MEDIA_DELIVERY_HMAC_KEY;
      else process.env.SUPPORT_MEDIA_DELIVERY_HMAC_KEY = priorKey;
    }
  });

  test('Meta media delivery uses the governed signed endpoint instead of a raw storage URL', () => {
    const service = fs.readFileSync(path.resolve(process.cwd(), 'services/supportMedia/SupportMediaDeliveryService.ts'), 'utf8');
    expect(service).toContain('createSupportMediaDeliveryUrl({ assetId: media.assetId, checksum: media.checksum })');
    expect(service).not.toContain('getFileUrl(media.derivativeStorageFileId');
  });

  test('production nginx sends the crawler-safe signed media path to the API', () => {
    const nginx = fs.readFileSync(path.resolve(process.cwd(), '../nginx/asksales.conf'), 'utf8');
    const location = nginx.slice(nginx.indexOf('location /support-media-delivery/'), nginx.indexOf('# WebSocket for /api/agents/progress'));
    expect(location).toContain('proxy_pass http://127.0.0.1:8080');
    expect(location).not.toContain('proxy_pass http://127.0.0.1:3000');
  });

  test('visual request wording does not drown out the entity search', () => {
    const query = buildMediaLexicalTsQuery('Can you please show me photos of the Sanctuary Villa?');
    expect(query).toContain('sanctuary:*');
    expect(query).toContain('villa:*');
    expect(query).not.toContain('photos:*');
  });

  test('multi-entity media selection includes each matched gallery before adding extra images', () => {
    const rows = [
      { id: 1, gallery_id: 10 }, { id: 2, gallery_id: 10 }, { id: 3, gallery_id: 10 },
      { id: 4, gallery_id: 20 }, { id: 5, gallery_id: 20 },
      { id: 6, gallery_id: 30 },
    ];
    expect(diversifyMediaCandidates(rows, 5).map((row) => row.id)).toEqual([1, 4, 6, 2, 5]);
  });

  test('relevance uses the configured AI, not substring matching shared gallery tags', () => {
    const gateway = fs.readFileSync(path.resolve(process.cwd(), 'services/supportMedia/MediaGateway.ts'), 'utf8');
    expect(gateway).toContain('await selectRelevantMediaCandidates');
    expect(gateway).not.toContain('filterExplicitEntityMatches');
  });

  test('migration forces tenant row security on every media table', () => {
    const migration = fs.readFileSync(path.resolve(process.cwd(), 'migrations/215_create_support_media_gallery.js'), 'utf8');
    for (const table of [
      'support_media_galleries', 'support_media_gallery_versions', 'support_media_assets',
      'support_media_asset_embeddings', 'support_media_retrieval_audits', 'support_media_delivery_parts',
    ]) {
      expect(migration).toContain(`'${table}'`);
    }
    expect(migration).toContain('ALTER TABLE ${table} FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("current_setting('app.current_user_id', true)");
  });

  test('gallery and asset inserts bind PostgreSQL text arrays explicitly', () => {
    const service = fs.readFileSync(path.resolve(process.cwd(), 'services/supportMedia/SupportMediaGalleryService.ts'), 'utf8');
    expect(service).toContain('jsonb_array_elements_text');
    expect(service).toContain('textArrayExpression(input.usageScopes');
    expect(service).toContain('textArrayExpression(input.allowedChannels)');
    expect(service).toContain('textArrayExpression(input.entityTags)');
    expect(service).toContain('textArrayExpression(ownerTags)');
    expect(service).toContain('textArrayExpression(scan.internalTags)');
  });

  test('external media safety and moderation calls have bounded provider timeouts', () => {
    const mediaSafety = fs.readFileSync(path.resolve(process.cwd(), 'services/supportMedia/SupportMediaSafetyService.ts'), 'utf8');
    const moderation = fs.readFileSync(path.resolve(process.cwd(), 'services/agents/orchestration/ContentModerationService.ts'), 'utf8');
    expect(mediaSafety).toContain('MEDIA_VISION_PROVIDER_TIMEOUT_MS');
    expect(mediaSafety).toContain('signal: AbortSignal.timeout(MEDIA_VISION_PROVIDER_TIMEOUT_MS)');
    expect(mediaSafety).toContain('maxRetries: 0');
    expect(moderation).toContain('MODERATION_PROVIDER_TIMEOUT_MS');
    expect(moderation).toContain('signal: AbortSignal.timeout(MODERATION_PROVIDER_TIMEOUT_MS)');
    expect(moderation).toContain('maxRetries: 0');
  });

  test('WhatsApp media upload and message dispatch are bounded by provider timeouts', () => {
    const whatsapp = fs.readFileSync(path.resolve(process.cwd(), 'services/whatsappApiService.ts'), 'utf8');
    const mediaUpload = whatsapp.slice(whatsapp.indexOf('async uploadMedia'), whatsapp.indexOf('async downloadMedia'));
    const dispatch = whatsapp.slice(whatsapp.indexOf('private async dispatch'), whatsapp.indexOf('private async getApiVersion'));
    expect(mediaUpload).toContain('signal: AbortSignal.timeout(15_000)');
    expect(dispatch).toContain('signal: AbortSignal.timeout(15_000)');
  });

  test('gallery UI retries an interrupted image upload against the same draft', () => {
    const page = fs.readFileSync(path.resolve(process.cwd(), '../client/src/app/dashboard/(main)/knowledge-base/media/page.tsx'), 'utf8');
    expect(page).toContain('draftGalleryId');
    expect(page).toContain('let galleryId = draftGalleryId');
    expect(page).toContain('setDraftGalleryId(galleryId)');
    expect(page).toContain('Retry image upload');
    expect(page).toContain('continueDraftUpload');
    expect(page).toContain('Continue image upload');
    expect(page).toContain('aria-label={`Open ${gallery.title} gallery`}');
    expect(page).toContain('event.key === "Enter" || event.key === " "');
    expect(page).toContain('Allowed channels');
    expect(page).toContain('allowedChannels: form.channels');
    expect(page).toContain('businessProfileId: form.businessProfileId');
  });

  test('gallery UI and tenant API expose complete gallery and image management', () => {
    const page = fs.readFileSync(path.resolve(process.cwd(), '../client/src/app/dashboard/(main)/knowledge-base/media/page.tsx'), 'utf8');
    const routes = fs.readFileSync(path.resolve(process.cwd(), 'routes/settings.routes.ts'), 'utf8');
    const service = fs.readFileSync(path.resolve(process.cwd(), 'services/supportMedia/SupportMediaGalleryService.ts'), 'utf8');
    expect(page).toContain('Add images');
    expect(page).toContain('Edit gallery');
    expect(page).toContain('Save image');
    expect(page).toContain('Replace image file');
    expect(page).toContain('Delete image?');
    expect(page).toContain('Delete gallery?');
    expect(routes).toContain("router.put('/media-galleries/:id', updateSupportMediaGallery)");
    expect(routes).toContain("router.patch('/media-galleries/:id/assets/:assetId', updateSupportMediaAsset)");
    expect(routes).toContain("router.post('/media-galleries/:id/assets/:assetId/replace', supportMediaReplaceUpload, replaceSupportMediaAsset)");
    expect(routes).toContain("router.delete('/media-galleries/:id/assets/:assetId', retireSupportMediaAsset)");
    expect(service).toContain('private async editableAsset');
    expect(service).toContain('async replaceAsset');
    expect(service).toContain("WHERE g.user_id = ${userId} AND g.status = 'active'");
    expect(service).toContain("A gallery must retain at least one image. Delete the gallery instead.");
  });

  test('support pipeline retrieves and verifies media outside agent personas', () => {
    const gateway = fs.readFileSync(path.resolve(process.cwd(), 'services/agents/pipeline/ChannelGateway.ts'), 'utf8');
    const retrieval = fs.readFileSync(path.resolve(process.cwd(), 'services/agents/pipeline/stages/MediaRetrievalStage.ts'), 'utf8');
    const dispatch = fs.readFileSync(path.resolve(process.cwd(), 'services/agents/pipeline/stages/AgentDispatchStage.ts'), 'utf8');
    const confidence = fs.readFileSync(path.resolve(process.cwd(), 'services/agents/pipeline/ConfidenceScorer.ts'), 'utf8');
    const mediaGateway = fs.readFileSync(path.resolve(process.cwd(), 'services/supportMedia/MediaGateway.ts'), 'utf8');
    expect(gateway).toContain('new MediaRetrievalStage()');
    expect(gateway).toContain('new MediaSelectionStage()');
    expect(gateway.indexOf('new MediaRetrievalStage()')).toBeLessThan(gateway.indexOf('new AgentDispatchStage()'));
    expect(gateway.indexOf('new AgentDispatchStage()')).toBeLessThan(gateway.indexOf('new MediaSelectionStage()'));
    expect(gateway.indexOf('new GuardrailComplianceStage()')).toBeLessThan(gateway.indexOf('new MediaSelectionStage()'));
    expect(retrieval).toContain('ctx.metadata?.skipAgentGeneration');
    expect(retrieval).toContain('ctx.verifiedMedia = []');
    expect(retrieval).toContain('ctx.verifiedMedia = await mediaGateway.verify');
    expect(dispatch).toContain("replyText: 'I found matching images for your request.'");
    expect(dispatch).toContain('mediaOnlyResponse: true');
    expect(gateway).toContain('new DeliveryStage()');
    expect(confidence).toContain('hasVerifiedExplicitMedia');
    expect(mediaGateway).toContain('textArrayExpression(evidence.map((item) => item.evidenceId), 5)');
    expect(mediaGateway).toContain('a.evidence_id=ANY(${textArrayExpression(ids, 5)})');
    expect(mediaGateway).not.toContain('${raw.length},${evidence.map((item) => item.evidenceId)}');
    expect(mediaGateway).not.toContain('a.evidence_id=ANY(${ids})');
  });

  test('playbook media delivery assertion requires provider acknowledgement', () => {
    const directive = {
      playbookId: 1, version: 1, runId: 1, nodeId: 'show-room', nodeType: 'message',
      compliance: { assertions: [{ type: 'media_delivery_succeeded' as const }] },
    };
    expect(playbookEngine.evaluateCompliance(directive, { replyText: 'Here are the images.', mediaDeliverySucceeded: false }).passed).toBe(false);
    expect(playbookEngine.evaluateCompliance(directive, { replyText: 'Here are the images.', mediaDeliverySucceeded: true }).passed).toBe(true);
  });

  test('model never receives storage keys or URLs as media evidence', () => {
    const types = fs.readFileSync(path.resolve(process.cwd(), 'services/supportMedia/types.ts'), 'utf8');
    const evidence = types.slice(types.indexOf('export interface MediaEvidence'), types.indexOf('export interface MediaRetrievalResult'));
    expect(evidence).not.toMatch(/storage|url/i);
  });
});
