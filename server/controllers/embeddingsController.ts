/**
 * Embeddings Controller
 * Only model listing is exposed. Raw generate/store/search/delete handlers
 * were removed: their routes were already unmounted, and tenant knowledge is
 * searched only through the governed KnowledgeGateway.
 */

import { Request, Response } from 'express';
import { embeddingService } from '../services/embeddings/EmbeddingService';

/**
 * GET /api/embeddings/models
 * List available embedding models.
 */
export async function getAvailableModels(_req: Request, res: Response) {
  return res.json({ success: true, data: embeddingService.getAvailableModels() });
}
