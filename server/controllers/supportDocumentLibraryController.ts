import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from 'express';
import { supportDocumentLibrary, type DocumentDraftInput } from '../services/supportDocuments/SupportDocumentLibrary.js';
import { contentDisposition } from '../utils/contentDisposition.js';

const owner = (req: Request) => Number(businessOwnerUserId(req) || 0);
function positive(value: unknown) {
  const number = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('A valid document ID and revision are required.');
  return number;
}
function draft(req: Request): DocumentDraftInput {
  return { title: req.body.title, description: req.body.description ?? '', service: req.body.service,
    storageFileId: positive(req.body.storageFileId),
    businessProfileId: req.body.businessProfileId == null ? null : positive(req.body.businessProfileId) };
}
function failure(res: Response, error: unknown) {
  const err = error as { code?: string; message?: string };
  if (err.code === '23505') return res.status(409).json({ success: false, error: 'That stored file is already in the Documents library.' });
  if (err.code) return res.status(503).json({ success: false, error: 'Documents are temporarily unavailable. Try again.' });
  const message = err.message || 'Document request failed.';
  return res.status(message.includes('not found') ? 404 : message.includes('changed') ? 409 : 400).json({ success: false, error: message });
}
export async function listSupportDocuments(req: Request, res: Response) {
  try { return res.json({ success: true, data: await supportDocumentLibrary.list(owner(req)) }); }
  catch (error) { return failure(res, error); }
}
export async function createSupportDocument(req: Request, res: Response) {
  try { return res.status(201).json({ success: true, data: await supportDocumentLibrary.save(owner(req), draft(req)) }); }
  catch (error) { return failure(res, error); }
}
export async function updateSupportDocument(req: Request, res: Response) {
  try { return res.json({ success: true, data: await supportDocumentLibrary.save(owner(req), draft(req),
    { id: positive(req.params.id), revision: positive(req.body.revision) }) }); }
  catch (error) { return failure(res, error); }
}
export async function publishSupportDocument(req: Request, res: Response) {
  try { return res.json({ success: true, data: await supportDocumentLibrary.publish(owner(req), positive(req.params.id), {
    revision: positive(req.body.revision), checksum: req.body.checksum, reason: req.body.reason,
    certified: req.body.certified === true, expiresAt: req.body.expiresAt,
  }) }); } catch (error) { return failure(res, error); }
}
export async function withdrawSupportDocument(req: Request, res: Response) {
  try { return res.json({ success: true, data: await supportDocumentLibrary.withdraw(owner(req), positive(req.params.id), {
    revision: positive(req.body.revision), reason: req.body.reason,
  }) }); } catch (error) { return failure(res, error); }
}
export async function downloadSupportDocument(req: Request, res: Response) {
  try {
    const file = await supportDocumentLibrary.download(owner(req), positive(req.params.id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(`${file.title}.pdf`));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    return res.send(file.buffer);
  } catch (error) { return failure(res, error); }
}
