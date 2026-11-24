import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { Router, raw, type Request, type Response } from 'express';
import {
  YouTubePublishingError,
  assignYouTubePlaylist,
  classifyYouTubeError,
  deleteYouTubeCaption,
  finalizeYouTubeResumableUpload,
  getYouTubeCapabilityReadiness,
  generateYouTubeChapterContent,
  getYouTubeResumableUploadStatus,
  initiateYouTubeResumableUpload,
  listYouTubeCaptions,
  listYouTubeComments,
  listYouTubePlaylists,
  moderateYouTubeComment,
  replyToYouTubeComment,
  setYouTubeThumbnail,
  syncYouTubeAnalytics,
  updateYouTubeVideoDetails,
  uploadYouTubeCaption,
  uploadYouTubeResumableChunk,
  validateYouTubeChapters,
} from '../services/social/YouTubePublishingService.js';
import { logger } from '../utils/logger.js';

const router = Router();

function tenantId(req: Request): number {
  // In this application the authenticated user is the tenant boundary for
  // channel credentials. Never trust a userId supplied in request input.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = Number(businessOwnerUserId(req));
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new YouTubePublishingError('Unauthorized', 'UNAUTHORIZED', 401);
  return userId;
}

function credentialId(req: Request): number {
  const id = Number(req.body?.credentialId ?? req.query.credentialId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new YouTubePublishingError('credentialId must identify the selected YouTube channel.', 'CREDENTIAL_REQUIRED', 400);
  return id;
}

async function run(req: Request, res: Response, action: (userId: number, credential: number) => Promise<unknown>) {
  try {
    return res.json({ success: true, data: await action(tenantId(req), credentialId(req)) });
  } catch (error) {
    const { deliverySetupFailure } = await import('../services/assistants/CustomerDeliveryGate.js');
    const setup = deliverySetupFailure(error);
    if (setup) return res.status(409).json(setup);
    const classified = classifyYouTubeError(error);
    const status = error instanceof YouTubePublishingError ? error.status : (classified.retryable || classified.ambiguous ? 502 : 422);
    logger.warn({ err: error, path: req.path }, '[YouTubeManagement] Provider action failed');
    return res.status(status).json({ success: false, error: classified.error, code: classified.errorCode, retryable: classified.retryable, ambiguous: classified.ambiguous });
  }
}

router.post('/uploads/initiate', (req, res) => run(req, res, (userId, credential) => initiateYouTubeResumableUpload(userId, credential, req.body || {})));
router.get('/readiness', (req, res) => run(req, res, (userId, credential) => getYouTubeCapabilityReadiness(userId, credential)));
router.put('/uploads/chunk', raw({ type: '*/*', limit: '16mb' }), (req, res) => {
  try {
    const sessionToken = String(req.get('x-upload-session') || '');
    const contentRange = String(req.get('content-range') || '');
    const contentType = String(req.get('content-type') || 'application/octet-stream');
    return uploadYouTubeResumableChunk(tenantId(req), sessionToken, contentRange, contentType, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0))
      .then(data => res.json({ success: true, data }))
      .catch(error => { const classified = classifyYouTubeError(error); return res.status(error instanceof YouTubePublishingError ? error.status : 502).json({ success: false, error: classified.error, code: classified.errorCode }); });
  } catch (error) { const classified = classifyYouTubeError(error); return res.status(error instanceof YouTubePublishingError ? error.status : 401).json({ success: false, error: classified.error, code: classified.errorCode }); }
});
router.post('/uploads/status', (req, res) => {
  try {
    return getYouTubeResumableUploadStatus(tenantId(req), String(req.body?.sessionToken || ''), Number(req.body?.contentLength))
      .then(data => res.json({ success: true, data }))
      .catch(error => { const classified = classifyYouTubeError(error); return res.status(error instanceof YouTubePublishingError ? error.status : 502).json({ success: false, error: classified.error, code: classified.errorCode }); });
  } catch (error) { const classified = classifyYouTubeError(error); return res.status(error instanceof YouTubePublishingError ? error.status : 401).json({ success: false, error: classified.error, code: classified.errorCode }); }
});
router.post('/uploads/finalize', (req, res) => {
  try {
    return finalizeYouTubeResumableUpload(tenantId(req), String(req.body?.sessionToken || ''), String(req.body?.videoId || ''))
      .then(data => res.json({ success: true, data }))
      .catch(error => { const classified = classifyYouTubeError(error); return res.status(error instanceof YouTubePublishingError ? error.status : 502).json({ success: false, error: classified.error, code: classified.errorCode }); });
  } catch (error) { const classified = classifyYouTubeError(error); return res.status(401).json({ success: false, error: classified.error, code: classified.errorCode }); }
});

router.patch('/videos/:videoId', (req, res) => run(req, res, (userId, credential) => updateYouTubeVideoDetails(userId, credential, req.params.videoId, req.body || {})));
router.post('/videos/:videoId/thumbnail', (req, res) => run(req, res, (userId, credential) => setYouTubeThumbnail(userId, credential, req.params.videoId, String(req.body?.thumbnailUrl || ''))));
router.get('/playlists', (req, res) => run(req, res, (userId, credential) => listYouTubePlaylists(userId, credential)));
router.post('/videos/:videoId/playlists', (req, res) => run(req, res, (userId, credential) => assignYouTubePlaylist(userId, credential, req.params.videoId, String(req.body?.playlistId || ''))));

router.get('/videos/:videoId/captions', (req, res) => run(req, res, (userId, credential) => listYouTubeCaptions(userId, credential, req.params.videoId)));
router.post('/videos/:videoId/captions', (req, res) => run(req, res, (userId, credential) => uploadYouTubeCaption(userId, credential, { ...(req.body || {}), videoId: req.params.videoId })));
router.delete('/captions/:captionId', (req, res) => run(req, res, (userId, credential) => deleteYouTubeCaption(userId, credential, req.params.captionId)));

router.post('/chapters/validate', (req, res) => {
  try { return res.json({ success: true, data: { chapters: validateYouTubeChapters(req.body?.chapters), description: generateYouTubeChapterContent(String(req.body?.description || ''), req.body?.chapters) } }); }
  catch (error) { const classified = classifyYouTubeError(error); return res.status(error instanceof YouTubePublishingError ? error.status : 422).json({ success: false, error: classified.error, code: classified.errorCode }); }
});
router.post('/analytics/sync', (req, res) => run(req, res, (userId, credential) => syncYouTubeAnalytics(userId, credential, req.body || {})));

router.get('/videos/:videoId/comments', (req, res) => run(req, res, (userId, credential) => listYouTubeComments(userId, credential, req.params.videoId, typeof req.query.pageToken === 'string' ? req.query.pageToken : undefined)));
router.post('/comments/:commentId/moderate', (req, res) => run(req, res, (userId, credential) => moderateYouTubeComment(userId, credential, req.params.commentId, req.body?.moderationStatus)));
router.post('/comments/:commentId/replies', (req, res) => run(req, res, (userId, credential) => replyToYouTubeComment(userId, credential, req.params.commentId, String(req.body?.text || ''), req.get('Idempotency-Key') || '')));

export default router;
