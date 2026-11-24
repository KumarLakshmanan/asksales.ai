import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { Request, Response } from 'express';
import { db } from '../models/db.js';
import { whatsappTemplatesTable, type WhatsAppTemplateRecord } from '../models/whatsappTemplates/schema.js';
import { eq, and, desc, asc, ilike, or, getTableColumns, sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { getActiveAdminCredential } from '../models/adminApiCredentials/functions.js';
import { whatsappApiService } from '../services/whatsappApiService.js';
import { templateActivity, templateSnapshot, existingApprovedSnapshot, parseTemplateListQuery, clientTemplateRevisionMatches, templateMediaReferences } from '../utils/whatsappTemplateWorkspace.js';
import { validateWhatsAppTemplateInput, type AuthenticationConfig } from '../utils/whatsappTemplatePayload.js';
import { nextTemplateRevision, providerTemplateSubmissionStatus, templateContentMatches, templateEditError, templateSubmissionError, templateSubmissionLeaseActive } from '../utils/whatsappTemplateLifecycle.js';
import multer from 'multer';
import { StorageService } from '../services/StorageService.js';
import { fetchPublicHttpUrl, readResponseBuffer } from '../utils/safeRemoteFetch.js';
import { whatsappTemplateRejectionReason } from '../../shared/whatsappTemplateStatus.js';
import { parsePositiveId as parseTemplateId } from '../utils/paramParsers.js';

const templateMediaTypes = new Set([
  'image/jpeg',
  'image/png',
  'video/mp4',
  'application/pdf',
]);

export const uploadWhatsAppTemplateMediaMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (templateMediaTypes.has(file.mimetype)) callback(null, true);
    else callback(new Error('Only JPEG, PNG, MP4, or PDF files are supported'));
  },
}).single('file');

function hasValidTemplateMediaSignature(file: Express.Multer.File): boolean {
  const bytes = file.buffer;
  if (bytes.length < 8) return false;
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString('ascii');
  if (file.mimetype === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.mimetype === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (file.mimetype === 'video/mp4') return ascii(4, 8) === 'ftyp';
  if (file.mimetype === 'application/pdf') return ascii(0, 5) === '%PDF-';
  return false;
}

async function deleteTemplateStoredMedia(reference: string, userId: number): Promise<boolean> {
  const privateFile = reference.match(/^\/api\/settings\/storage\/files\/(\d+)\/download(?:\?|$)/);
  const storage = StorageService.getInstance();
  return privateFile ? storage.deleteFile(Number(privateFile[1]), userId) : storage.deleteByUrl(reference, userId);
}

// Preserve PostgreSQL microseconds for optimistic locking; Date loses them.
const templateRevisionSelection = {
  ...getTableColumns(whatsappTemplatesTable),
  revision: sql<string>`${whatsappTemplatesTable.updatedAt}::text`,
};
const revisionMatches = (revision: string) => sql`${whatsappTemplatesTable.updatedAt} = ${revision}::timestamp`;

function readMetaExampleValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const values = Array.isArray(value[0]) ? value[0] : value;
  return values.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function mergeMetaComponentExamples(
  target: Record<string, string>,
  component: Record<string, unknown> | undefined,
  exampleKey: 'header_text' | 'body_text',
  componentName: 'header' | 'body',
) {
  if (!component || typeof component.text !== 'string' || !component.example || typeof component.example !== 'object') return;
  const indexes = [...new Set(Array.from(component.text.matchAll(/{{\s*(\d+)\s*}}/g), (match) => String(Number(match[1]))))];
  const values = readMetaExampleValues((component.example as Record<string, unknown>)[exampleKey]);
  indexes.forEach((index, position) => {
    if (values[position]) target[`${componentName}:${index}`] = values[position];
  });
}

function templateExample(template: WhatsAppTemplateRecord, component: 'header' | 'body', index: string): string {
  const examples = template.examples && typeof template.examples === 'object'
    ? template.examples as Record<string, unknown>
    : {};
  return String(examples[`${component}:${index}`] || examples[index] || `Example ${index}`);
}

type TemplateCompatibilityInput = {
  category?: string | null;
  body?: string | null;
  header?: string | null;
  headerType?: string | null;
  buttons?: unknown;
  wabaTemplateId?: string | null;
  metaStatus?: string | null;
  status?: string | null;
  hasLocalChanges?: boolean;
};

export function supportNotificationTemplateCompatibility(template: TemplateCompatibilityInput) {
  const reasons: string[] = [];
  if (String(template.category || '').toUpperCase() !== 'UTILITY') reasons.push('Utility category required');
  if (!template.wabaTemplateId) reasons.push('Not linked to Meta');
  if (String(template.metaStatus || template.status || '').toUpperCase() !== 'APPROVED') reasons.push('Meta approval required');
  if (template.hasLocalChanges === true || String(template.status || '').toUpperCase() === 'DRAFT') {
    reasons.push('Local changes must be submitted and approved before use');
  }
  const headerType = String(template.headerType || 'NONE').toUpperCase();
  if (!['NONE', 'TEXT'].includes(headerType)) reasons.push('Dynamic media headers are not supported');
  if (headerType === 'TEXT' && /{{\s*\d+\s*}}/.test(template.header || '')) reasons.push('Dynamic headers are not supported');
  const buttons = Array.isArray(template.buttons) ? template.buttons as Array<Record<string, unknown>> : [];
  if (buttons.some((button) => String(button.url || '').includes('{{'))) reasons.push('Dynamic URL buttons are not supported');
  const positions = Array.from(String(template.body || '').matchAll(/{{\s*(\d+)\s*}}/g), (match) => Number(match[1]));
  const unique = [...new Set(positions)].sort((left, right) => left - right);
  if (!unique.length) reasons.push('At least one numbered body parameter is required');
  if (unique.some((position, index) => position !== index + 1)) reasons.push('Body parameters must be contiguous from {{1}}');
  if (unique.length !== 7) reasons.push('Support ticket alerts require exactly seven body parameters');
  return { compatible: reasons.length === 0, reasons, parameterCount: unique.length };
}

export function buildMetaTemplateComponents(template: WhatsAppTemplateRecord, mediaHandle?: string): Array<Record<string, unknown>> {
  if (template.category === 'AUTHENTICATION') {
    const auth = template.authConfig as AuthenticationConfig | null;
    if (!auth) throw new Error('Authentication templates require OTP settings');
    return [
      { type: 'BODY', add_security_recommendation: auth.addSecurityRecommendation },
      { type: 'FOOTER', code_expiration_minutes: auth.codeExpirationMinutes },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: auth.otpType, text: auth.buttonText,
        ...(auth.otpType === 'ONE_TAP' ? { autofill_text: auth.autofillText,
          supported_apps: [{ package_name: auth.packageName, signature_hash: auth.signatureHash }] } : {}) }] },
    ];
  }
  const components: Array<Record<string, unknown>> = [];
  const headerType = String(template.headerType || 'NONE').toUpperCase();
  if (headerType === 'TEXT' && template.header?.trim()) {
    const header: Record<string, unknown> = { type: 'HEADER', format: 'TEXT', text: template.header.trim() };
    const headerIndexes = Array.from(template.header.matchAll(/{{\s*(\d+)\s*}}/g), (match) => String(Number(match[1])));
    if (headerIndexes.length) {
      header.example = { header_text: [...new Set(headerIndexes)].map((index) => templateExample(template, 'header', index)) };
    }
    components.push(header);
  } else if (!['NONE', 'TEXT'].includes(headerType)) {
    if (!mediaHandle) throw new Error('Upload header media before submitting this template to Meta.');
    components.push({ type: 'HEADER', format: headerType, example: { header_handle: [mediaHandle] } });
  }
  const bodyIndexes = Array.from(template.body.matchAll(/{{\s*(\d+)\s*}}/g), (match) => String(Number(match[1])));
  const body: Record<string, unknown> = { type: 'BODY', text: template.body };
  if (bodyIndexes.length) {
    body.example = { body_text: [[...new Set(bodyIndexes)].map((index) => templateExample(template, 'body', index))] };
  }
  components.push(body);
  if (template.footer?.trim()) components.push({ type: 'FOOTER', text: template.footer.trim() });
  const buttons = Array.isArray(template.buttons) ? template.buttons as Array<Record<string, unknown>> : [];
  if (buttons.length) components.push({ type: 'BUTTONS', buttons: buttons.map((button) => ({
    type: button.type,
    text: button.text,
    ...(button.url ? { url: button.url } : {}),
    ...(button.phone_number ? { phone_number: button.phone_number } : {}),
  })) });
  return components;
}

const templateMediaLimits: Record<string, number> = {
  IMAGE: 5 * 1024 * 1024,
  VIDEO: 16 * 1024 * 1024,
  DOCUMENT: 100 * 1024 * 1024,
};

const templateMediaMimeTypes: Record<string, Set<string>> = {
  IMAGE: new Set(['image/jpeg', 'image/png']),
  VIDEO: new Set(['video/mp4']),
  DOCUMENT: new Set(['application/pdf']),
};

async function readTemplateMedia(template: WhatsAppTemplateRecord, userId: number): Promise<{ buffer: Buffer; mimeType: string; fileName: string } | null> {
  const reference = String(template.headerMediaUrl || '').trim();
  if (!reference) return null;
  const privateFile = reference.match(/^\/api\/settings\/storage\/files\/(\d+)\/download(?:\?|$)/);
  if (privateFile || reference.startsWith('/uploads/')) {
    const storage = StorageService.getInstance();
    const stored = privateFile
      ? await storage.downloadFile(Number(privateFile[1]), userId)
      : await storage.downloadByUrl(reference, userId);
    if (!stored) throw new Error('The uploaded header media is no longer available. Upload it again.');
    return { buffer: stored.buffer, mimeType: stored.file.mimeType || 'application/octet-stream', fileName: stored.file.originalName || stored.file.fileName };
  }
  if (!/^https?:\/\//i.test(reference)) return null;

  const { response, finalUrl } = await fetchPublicHttpUrl(reference, {
    signal: AbortSignal.timeout(20_000),
    headers: { 'User-Agent': 'AskSalesWhatsAppTemplate/1.0' },
  }, 3);
  if (!response.ok) throw new Error(`Header media could not be downloaded (HTTP ${response.status}).`);
  const headerType = String(template.headerType || '').toUpperCase();
  const buffer = await readResponseBuffer(response, templateMediaLimits[headerType] || 100 * 1024 * 1024);
  const mimeType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  const fileName = new URL(finalUrl).pathname.split('/').pop() || `whatsapp-${headerType.toLowerCase()}`;
  return { buffer, mimeType, fileName };
}

async function resolveMetaTemplateMediaHandle(input: {
  template: WhatsAppTemplateRecord;
  userId: number;
  accessToken: string;
  appId: string;
  apiVersion: string;
}): Promise<string | undefined> {
  const headerType = String(input.template.headerType || 'NONE').toUpperCase();
  if (!['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType)) return undefined;
  const reference = String(input.template.headerMediaUrl || '').trim();
  if (/^(?:\d+:){1,2}:?[^\s]+$/.test(reference)) return reference;
  const media = await readTemplateMedia(input.template, input.userId);
  if (!media) throw new Error('Upload header media before submitting this template to Meta.');
  if (!templateMediaMimeTypes[headerType]?.has(media.mimeType)) {
    throw new Error(`${headerType === 'IMAGE' ? 'Images must be JPEG or PNG' : headerType === 'VIDEO' ? 'Videos must be MP4' : 'Documents must be PDF'} before Meta submission.`);
  }
  if (media.buffer.length > templateMediaLimits[headerType]) {
    throw new Error(`${headerType[0]}${headerType.slice(1).toLowerCase()} header media exceeds WhatsApp's size limit.`);
  }
  if (!hasValidTemplateMediaSignature({ buffer: media.buffer, mimetype: media.mimeType } as Express.Multer.File)) {
    throw new Error('The header media content does not match its declared file type.');
  }

  const sessionUrl = new URL(`https://graph.facebook.com/${input.apiVersion}/${input.appId}/uploads`);
  sessionUrl.searchParams.set('file_length', String(media.buffer.length));
  sessionUrl.searchParams.set('file_type', media.mimeType);
  sessionUrl.searchParams.set('file_name', media.fileName.slice(0, 255));
  const sessionResponse = await fetch(sessionUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const session = await sessionResponse.json().catch(() => ({})) as { id?: string; error?: { message?: string } };
  if (!sessionResponse.ok || !session.id) throw new Error(session.error?.message || 'Meta could not create the media upload session.');

  const uploadResponse = await fetch(`https://graph.facebook.com/${input.apiVersion}/${session.id}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': media.mimeType,
      file_offset: '0',
    },
    body: media.buffer,
    signal: AbortSignal.timeout(30_000),
  });
  const upload = await uploadResponse.json().catch(() => ({})) as { h?: string; error?: { message?: string } };
  if (!uploadResponse.ok || !upload.h) throw new Error(upload.error?.message || 'Meta could not upload the template header media.');
  return upload.h;
}

/**
 * WhatsApp Template Controller
 * Handles local management and (optionally) Meta API sync for templates
 */

export async function getTemplates(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const paginated = ['page', 'pageSize', 'search', 'category', 'status', 'language', 'sort'].some((key) => req.query[key] != null);
    if (!paginated) {
      const templates = await db.select().from(whatsappTemplatesTable).where(eq(whatsappTemplatesTable.userId, userId))
        .orderBy(desc(whatsappTemplatesTable.updatedAt), desc(whatsappTemplatesTable.id));
      return res.json({ success: true, templates });
    }
    const parsed = parseTemplateListQuery(req.query);
    if (!parsed.data) return res.status(400).json({ error: parsed.error });
    const filters = parsed.data;
    const owner = eq(whatsappTemplatesTable.userId, userId);
    const predicates = [owner];
    if (filters.search) {
      const escaped = filters.search.replace(/[\\%_]/g, (value) => `\\${value}`);
      predicates.push(or(ilike(whatsappTemplatesTable.name, `%${escaped}%`), ilike(whatsappTemplatesTable.body, `%${escaped}%`))!);
    }
    if (filters.category) predicates.push(eq(whatsappTemplatesTable.category, filters.category));
    if (filters.language) predicates.push(eq(whatsappTemplatesTable.language, filters.language));
    // Counts apply the search/category/language filters and include every status.
    const facetPredicate = and(...predicates);
    if (filters.status) predicates.push(eq(whatsappTemplatesTable.status, filters.status));
    const predicate = and(...predicates);
    const sorting = filters.sort === 'name_asc' ? asc(whatsappTemplatesTable.name)
      : filters.sort === 'name_desc' ? desc(whatsappTemplatesTable.name)
      : filters.sort === 'updated_asc' ? asc(whatsappTemplatesTable.updatedAt) : desc(whatsappTemplatesTable.updatedAt);
    const [templates, totals, statuses, languages] = await Promise.all([
      db.select().from(whatsappTemplatesTable).where(predicate).orderBy(sorting, desc(whatsappTemplatesTable.id))
        .limit(filters.pageSize).offset((filters.page - 1) * filters.pageSize),
      db.select({ count: sql<number>`count(*)::int` }).from(whatsappTemplatesTable).where(predicate),
      db.select({ status: whatsappTemplatesTable.status, count: sql<number>`count(*)::int` }).from(whatsappTemplatesTable).where(facetPredicate).groupBy(whatsappTemplatesTable.status),
      db.selectDistinct({ language: whatsappTemplatesTable.language }).from(whatsappTemplatesTable).where(owner).orderBy(asc(whatsappTemplatesTable.language)),
    ]);
    return res.json({ success: true, templates, total: totals[0]?.count || 0, page: filters.page, pageSize: filters.pageSize,
      statusCounts: Object.fromEntries(statuses.map((item: { status: string; count: number }) => [item.status, item.count])),
      languages: languages.map((item: { language: string }) => item.language) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WhatsAppTemplateController] Error getting templates');
    res.status(500).json({ error: 'Failed to retrieve templates' });
  }
}

export async function getTemplate(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const id = parseTemplateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid template ID' });
    const [template] = await db.select(templateRevisionSelection).from(whatsappTemplatesTable).where(
      and(eq(whatsappTemplatesTable.id, id), eq(whatsappTemplatesTable.userId, userId)),
    ).limit(1);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    return res.json({ success: true, template });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WhatsAppTemplateController] Error getting template');
    return res.status(500).json({ error: 'Failed to retrieve template' });
  }
}

export async function createTemplate(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const parsed = validateWhatsAppTemplateInput(req.body, { draftOnly: req.body?.draftOnly === true });
    if (!parsed.data) return res.status(400).json({ error: parsed.error });
    const { name, language, category, body, header, headerType, headerMediaUrl, footer, buttons, examples, authConfig, variableLabels } = parsed.data;
    const duplicate = await db.select({ id: whatsappTemplatesTable.id }).from(whatsappTemplatesTable).where(
      and(eq(whatsappTemplatesTable.userId, userId), eq(whatsappTemplatesTable.name, name)),
    ).limit(1);
    if (duplicate.length) return res.status(409).json({ error: 'A WhatsApp template with this name already exists' });

    const [newTemplate] = await db.insert(whatsappTemplatesTable).values({
      userId,
      name,
      language: language || 'en',
      category: category || 'MARKETING',
      body,
      header,
      headerType: headerType || 'TEXT',
      headerMediaUrl: headerMediaUrl || null,
      footer,
      buttons: buttons || null,
      examples, authConfig, variableLabels,
      activityHistory: templateActivity(null, 'created', parsed.data, 'DRAFT'),
      status: 'DRAFT',
      hasLocalChanges: true,
    }).returning(templateRevisionSelection);
    
    return res.json({ success: true, template: newTemplate });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error?.code === '23505') return res.status(409).json({ error: 'A WhatsApp template with this name already exists' });
    logger.error({ err: error }, '[WhatsAppTemplateController] Error creating template');
    res.status(500).json({ error: 'Failed to create template' });
  }
}

export async function uploadTemplateMedia(req: Request, res: Response) {
  let uploadedUrl: string | undefined;
  let uploadUserId: number | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const id = parseTemplateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid template ID' });
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'A media file is required' });
    if (!hasValidTemplateMediaSignature(file)) {
      return res.status(400).json({ error: 'The uploaded file content does not match its declared media type' });
    }

    const [template] = await db.select(templateRevisionSelection).from(whatsappTemplatesTable).where(
      and(eq(whatsappTemplatesTable.id, id), eq(whatsappTemplatesTable.userId, userId)),
    ).limit(1);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    const editError = templateEditError(template, template, template);
    if (editError) return res.status(409).json({ error: editError });

    const headerType = String(template.headerType || 'NONE').toUpperCase();
    const validForHeader = headerType === 'IMAGE'
      ? file.mimetype.startsWith('image/')
      : headerType === 'VIDEO'
        ? file.mimetype.startsWith('video/')
        : headerType === 'DOCUMENT'
          ? file.mimetype === 'application/pdf'
          : false;
    if (!validForHeader) {
      return res.status(400).json({ error: `Choose a file that matches the ${headerType.toLowerCase()} header type` });
    }
    if (file.size > (templateMediaLimits[headerType] || 0)) {
      return res.status(400).json({ error: `${headerType[0]}${headerType.slice(1).toLowerCase()} header media exceeds WhatsApp's size limit` });
    }

    uploadUserId = Number(userId);
    const storage = StorageService.getInstance();
    const uploaded = await storage.upload(file.buffer, {
      userId: uploadUserId,
      category: 'content_asset',
      originalName: file.originalname,
      mimeType: file.mimetype,
      referenceType: 'whatsapp_template',
      referenceId: String(id),
      metadata: { headerType },
    });
    uploadedUrl = uploaded.url;

    const [updatedTemplate] = await db.update(whatsappTemplatesTable)
      .set({ activityHistory: templateActivity(template, 'media_uploaded', { ...template, headerMediaUrl: uploaded.url }), approvedSnapshot: existingApprovedSnapshot(template), headerMediaUrl: uploaded.url, status: 'DRAFT', submissionStatus: 'local_draft', metaRejectionReason: null, hasLocalChanges: true, updatedAt: nextTemplateRevision(template.updatedAt) })
      .where(and(eq(whatsappTemplatesTable.id, id), eq(whatsappTemplatesTable.userId, uploadUserId), revisionMatches(template.revision)))
      .returning(templateRevisionSelection);
    if (!updatedTemplate) throw new Error('Template changed before its media could be attached');

    const retainedMedia = new Set(templateMediaReferences(updatedTemplate));
    for (const previousMedia of templateMediaReferences(template).filter((reference) => !retainedMedia.has(reference))) {
      try {
        await deleteTemplateStoredMedia(previousMedia, uploadUserId);
      } catch (cleanupError) {
        logger.warn({ err: cleanupError, templateId: id }, '[WhatsAppTemplateController] Previous template media cleanup failed');
      }
    }

    return res.status(201).json({ success: true, url: uploaded.url, template: updatedTemplate });
  } catch (error) {
    if (uploadedUrl && uploadUserId) {
      try {
        await deleteTemplateStoredMedia(uploadedUrl, uploadUserId);
      } catch (cleanupError) {
        logger.warn({ err: cleanupError, uploadedUrl }, '[WhatsAppTemplateController] Unattached template media cleanup failed');
      }
    }
    logger.error({ err: error }, '[WhatsAppTemplateController] Template media upload failed');
    return res.status(500).json({ error: 'Failed to upload template media' });
  }
}

export async function updateTemplate(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const id = parseTemplateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid template ID' });
    const parsed = validateWhatsAppTemplateInput(req.body, { draftOnly: req.body?.draftOnly === true });
    if (!parsed.data) return res.status(400).json({ error: parsed.error });
    const { name, language, category, body, header, headerType, headerMediaUrl, footer, buttons, examples, authConfig, variableLabels } = parsed.data;
    const [existingTemplate] = await db.select(templateRevisionSelection).from(whatsappTemplatesTable).where(
      and(eq(whatsappTemplatesTable.id, id), eq(whatsappTemplatesTable.userId, userId)),
    ).limit(1);
    if (!existingTemplate) return res.status(404).json({ error: 'Template not found' });
    if (!clientTemplateRevisionMatches(req.body?.clientRevision ?? req.body?.revision, existingTemplate)) return res.status(409).json({ error: 'A newer version was saved. Reload and review it before saving your changes.' });
    const editError = templateEditError(existingTemplate, { name, language, category }, existingTemplate);
    if (editError) return res.status(409).json({ error: editError });
    const duplicate = await db.select({ id: whatsappTemplatesTable.id }).from(whatsappTemplatesTable).where(
      and(eq(whatsappTemplatesTable.userId, userId), eq(whatsappTemplatesTable.name, name)),
    );
    if (duplicate.some((template: { id: number }) => template.id !== id)) return res.status(409).json({ error: 'A WhatsApp template with this name already exists' });

    const [updatedTemplate] = await db.update(whatsappTemplatesTable)
      .set({
        name,
        language,
        category,
        body,
        header,
        headerType: headerType || 'TEXT',
        headerMediaUrl: headerMediaUrl || null,
        footer,
        buttons: buttons || null,
        examples, authConfig, variableLabels,
        activityHistory: templateActivity(existingTemplate, 'edited', parsed.data, 'DRAFT'),
        approvedSnapshot: existingApprovedSnapshot(existingTemplate),
        status: 'DRAFT',
        submissionStatus: 'local_draft',
        metaRejectionReason: null,
        hasLocalChanges: true,
        updatedAt: nextTemplateRevision(existingTemplate.updatedAt),
      })
      .where(and(eq(whatsappTemplatesTable.id, id), eq(whatsappTemplatesTable.userId, userId), revisionMatches(existingTemplate.revision)))
      .returning(templateRevisionSelection);

    if (!updatedTemplate) {
      return res.status(409).json({ error: 'Template changed while you were saving. Reload and review the latest version.' });
    }

    return res.json({ success: true, template: updatedTemplate });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error?.code === '23505') return res.status(409).json({ error: 'A WhatsApp template with this name already exists' });
    logger.error({ err: error }, '[WhatsAppTemplateController] Error updating template');
    res.status(500).json({ error: 'Failed to update template' });
  }
}

export async function deleteTemplate(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const id = parseTemplateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid template ID' });
    const [template] = await db.select(templateRevisionSelection).from(whatsappTemplatesTable).where(
      and(eq(whatsappTemplatesTable.id, id), eq(whatsappTemplatesTable.userId, userId)),
    ).limit(1);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    if (['submitting', 'submission_uncertain'].includes(template.submissionStatus)) {
      return res.status(409).json({ error: 'Sync the outstanding submission before deleting this local template.' });
    }

    const [deletedTemplate] = await db.delete(whatsappTemplatesTable)
      .where(and(eq(whatsappTemplatesTable.id, id), eq(whatsappTemplatesTable.userId, userId), revisionMatches(template.revision)))
      .returning(templateRevisionSelection);

    if (!deletedTemplate) {
      return res.status(409).json({ error: 'Template changed while deleting. Reload before retrying.' });
    }

    for (const reference of templateMediaReferences(deletedTemplate)) {
      try {
        await deleteTemplateStoredMedia(reference, Number(userId));
      } catch (cleanupError) {
        logger.warn({ err: cleanupError, templateId: id }, '[WhatsAppTemplateController] Deleted template media cleanup failed');
      }
    }

    // Future improvement: Attempt to delete from Meta if wabaTemplateId exists
    
    return res.json({ success: true, message: 'Template deleted successfully' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error?.code === '23503') return res.status(409).json({ error: 'This template is used by support notifications. Remove its binding before deleting it.' });
    logger.error({ err: error }, '[WhatsAppTemplateController] Error deleting template');
    res.status(500).json({ error: 'Failed to delete template' });
  }
}

/** Submit a reviewed local text template to the tenant's connected Meta WABA. */
export async function submitTemplate(req: Request, res: Response) {
  let submissionClaim: { id: number; userId: number; updatedAt: Date; template: WhatsAppTemplateRecord } | null = null;
  try {
    const userId = Number(businessOwnerUserId(req));
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const id = parseTemplateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid template ID' });
    const [template] = await db.select(templateRevisionSelection).from(whatsappTemplatesTable).where(
      and(eq(whatsappTemplatesTable.id, id), eq(whatsappTemplatesTable.userId, userId)),
    ).limit(1);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    const submissionError = templateSubmissionError(template);
    if (submissionError) return res.status(409).json({ error: submissionError });
    const validation = validateWhatsAppTemplateInput(template);
    if (!validation.data) return res.status(400).json({ error: validation.error });
    const creds = await whatsappApiService.resolveCreds(userId);
    if (!creds?.accessToken || !creds.businessAccountId) {
      return res.status(400).json({ error: 'Connect a WhatsApp Business Account before submitting templates.' });
    }
    const adminCred = await getActiveAdminCredential('meta_app');
    const apiVersion = (adminCred?.config as { apiVersion?: string } | null)?.apiVersion || 'v25.0';
    if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(String(template.headerType || '').toUpperCase()) && !adminCred?.apiKey) {
      return res.status(503).json({ error: 'Meta app configuration is unavailable for template media uploads.' });
    }
    const accessToken = await whatsappApiService.ensureTokenValidity(creds);
    const mediaHandle = await resolveMetaTemplateMediaHandle({
      template,
      userId,
      accessToken,
      appId: adminCred?.apiKey || '',
      apiVersion,
    });
    const components = buildMetaTemplateComponents(template, mediaHandle);
    const resubmitting = Boolean(template.wabaTemplateId);
    const claimTime = nextTemplateRevision(template.updatedAt);
    const [claimed] = await db.update(whatsappTemplatesTable).set({
      submissionStatus: 'submitting', updatedAt: claimTime,
      submittedSnapshot: templateSnapshot({ ...template, headerMediaUrl: mediaHandle || template.headerMediaUrl }),
    }).where(and(eq(whatsappTemplatesTable.id, id), eq(whatsappTemplatesTable.userId, userId),
      revisionMatches(template.revision))).returning(templateRevisionSelection);
    if (!claimed) return res.status(409).json({ error: 'Template changed or is already being submitted. Reload before retrying.' });
    submissionClaim = { id, userId, updatedAt: claimTime, template };
    const endpoint = resubmitting
      ? `https://graph.facebook.com/${apiVersion}/${template.wabaTemplateId}`
      : `https://graph.facebook.com/${apiVersion}/${creds.businessAccountId}/message_templates`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(resubmitting ? {
        ...(String(template.metaStatus).toUpperCase() === 'APPROVED' ? {} : { category: template.category }),
        components,
      } : {
        name: template.name, language: template.language, category: template.category,
        components,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json() as { id?: string; success?: boolean; status?: string; error?: { message?: string; error_user_msg?: string } };
    if (!response.ok || (!payload.id && !(resubmitting && payload.success))) {
      const reason = payload.error?.error_user_msg || payload.error?.message || 'Meta rejected the template submission.';
      await db.update(whatsappTemplatesTable).set({
        activityHistory: templateActivity(template, 'submission_failed', undefined, 'FAILED'),
        submissionStatus: 'submission_failed', metaRejectionReason: String(reason).slice(0, 2000), updatedAt: new Date(),
      }).where(and(eq(whatsappTemplatesTable.id, id), eq(whatsappTemplatesTable.userId, userId),
        eq(whatsappTemplatesTable.updatedAt, claimTime)));
      submissionClaim = null;
      return res.status(422).json({ error: reason });
    }
    const providerStatus = String(payload.status || 'PENDING').toUpperCase();
    const [updated] = await db.update(whatsappTemplatesTable).set({
      wabaTemplateId: String(payload.id || template.wabaTemplateId),
      metaStatus: providerStatus,
      status: providerStatus,
      submissionStatus: providerTemplateSubmissionStatus(providerStatus),
      submittedAt: new Date(),
      activityHistory: templateActivity(template, 'submitted', template, providerStatus),
      approvedSnapshot: providerStatus === 'APPROVED' ? templateSnapshot(template) : existingApprovedSnapshot(template),
      metaRejectionReason: null,
      hasLocalChanges: false,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(whatsappTemplatesTable.id, id), eq(whatsappTemplatesTable.userId, userId),
      eq(whatsappTemplatesTable.updatedAt, claimTime))).returning(templateRevisionSelection);
    if (!updated) throw new Error('Meta received the submission, but its local status needs synchronization.');
    submissionClaim = null;
    return res.status(202).json({ success: true, template: updated });
  } catch (error) {
    if (submissionClaim) {
      const claim = submissionClaim;
      await db.update(whatsappTemplatesTable).set({
        activityHistory: templateActivity(claim.template, 'submission_uncertain', undefined, 'UNCERTAIN'),
        submissionStatus: 'submission_uncertain', hasLocalChanges: true,
        status: 'DRAFT', metaRejectionReason: 'Submission outcome is uncertain. Sync with Meta before retrying.', updatedAt: new Date(),
      }).where(and(eq(whatsappTemplatesTable.id, claim.id), eq(whatsappTemplatesTable.userId, claim.userId),
        eq(whatsappTemplatesTable.updatedAt, claim.updatedAt))).catch(() => undefined);
    }
    logger.error({ err: error }, '[WhatsAppTemplateController] Template submission failed');
    return res.status(502).json({ error: error instanceof Error ? error.message : 'Failed to submit template to Meta.' });
  }
}

/**
 * POST /api/whatsapp/templates/sync
 * Manually trigger sync with Meta Business Account
 */
export async function syncTemplates(req: Request, res: Response) {
  return synchronizeTemplates(req, res);
}

export async function refreshTemplate(req: Request, res: Response) {
  const id = parseTemplateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid template ID' });
  return synchronizeTemplates(req, res, id);
}

async function synchronizeTemplates(req: Request, res: Response, refreshId?: number) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const [refreshTarget] = refreshId ? await db.select(templateRevisionSelection).from(whatsappTemplatesTable).where(
      and(eq(whatsappTemplatesTable.id, refreshId), eq(whatsappTemplatesTable.userId, userId)),
    ).limit(1) : [];
    if (refreshId && !refreshTarget) return res.status(404).json({ error: 'Template not found' });
    if (refreshTarget && !refreshTarget.wabaTemplateId && !['submitting', 'submission_uncertain'].includes(refreshTarget.submissionStatus)) return res.status(400).json({ error: 'This local draft has not been submitted to Meta.' });
    if (refreshTarget && templateSubmissionLeaseActive(refreshTarget)) return res.status(409).json({ error: 'Submission is still in progress. Check its status after it finishes.' });

    // Use the shared resolver so encrypted new records and legacy plaintext
    // records behave identically during the credential migration.
    const creds = await whatsappApiService.resolveCreds(userId);
    if (!creds?.accessToken || !creds.businessAccountId) {
      return res.status(400).json({ error: 'WhatsApp not configured or Business Account ID missing' });
    }

    const adminCred = await getActiveAdminCredential('meta_app');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apiVersion = (adminCred?.config as any)?.apiVersion || 'v25.0';

    // Fetch every Meta page. Only accept the Graph API's own pagination URL.
    const accessToken = await whatsappApiService.ensureTokenValidity(creds);
    let nextUrl: string | null =
      `https://graph.facebook.com/${apiVersion}/${creds.businessAccountId}/message_templates` +
      "?fields=id,name,language,category,status,components,rejected_reason&limit=100";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metaTemplates: any[] = [];
    for (let page = 0; nextUrl && page < 50; page += 1) {
      const response = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const metaData = await response.json() as any;
      if (!response.ok) throw new Error(`Meta API Error: ${JSON.stringify(metaData)}`);
      if (Array.isArray(metaData.data)) metaTemplates.push(...metaData.data);
      const candidate = typeof metaData.paging?.next === 'string' ? metaData.paging.next : null;
      if (!candidate) {
        nextUrl = null;
      } else {
        const parsedNext = new URL(candidate);
        if (parsedNext.protocol !== 'https:' || parsedNext.hostname !== 'graph.facebook.com') {
          throw new Error('Meta returned an invalid template pagination URL');
        }
        nextUrl = parsedNext.toString();
      }
    }
    
    if (nextUrl) throw new Error('Template synchronization exceeded the page limit; no partial update was applied.');
    let synchronized = 0;
    const skipped: Array<{ name: string; reason: string }> = [];
    // A provider status never approves a different, unsent local revision.
    for (const mt of metaTemplates) {
      if (refreshTarget && (mt.name !== refreshTarget.name || mt.language !== refreshTarget.language)) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bodyComponent = mt.components?.find((c: any) => c.type === 'BODY');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const headerComponent = mt.components?.find((c: any) => c.type === 'HEADER');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const footerComponent = mt.components?.find((c: any) => c.type === 'FOOTER');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buttonComponents = mt.components?.filter((c: any) => c.type === 'BUTTONS') || [];

      // Parse header type and media
      let headerType = headerComponent ? 'TEXT' : 'NONE';
      let headerMediaUrl = null;
      const headerText = headerComponent?.text || null;
      if (headerComponent) {
        if (headerComponent.format === 'IMAGE') { headerType = 'IMAGE'; }
        else if (headerComponent.format === 'VIDEO') { headerType = 'VIDEO'; }
        else if (headerComponent.format === 'DOCUMENT') { headerType = 'DOCUMENT'; }
        if (headerComponent.example?.header_handle?.[0]) {
          headerMediaUrl = headerComponent.example.header_handle[0];
        }
      }

      // Parse buttons
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buttons = (buttonComponents[0]?.buttons || []).map((btn: any) => ({
        type: btn.type, // QUICK_REPLY, URL, PHONE_NUMBER
        text: btn.text,
        url: btn.url || null,
        phone_number: btn.phone_number || null,
      }));

      const metaExamples: Record<string, string> = {};
      mergeMetaComponentExamples(metaExamples, headerComponent, 'header_text', 'header');
      mergeMetaComponentExamples(metaExamples, bodyComponent, 'body_text', 'body');

      // Check if exists locally
      const existing = await db.select(templateRevisionSelection).from(whatsappTemplatesTable).where(
        and(eq(whatsappTemplatesTable.userId, userId), eq(whatsappTemplatesTable.name, mt.name))
      ).limit(1);

      if (existing.length > 0) {
        if (existing[0].language !== mt.language) {
          skipped.push({ name: mt.name, reason: 'A different language already uses this local name; it was not overwritten.' });
          continue;
        }
        if (existing[0].wabaTemplateId && existing[0].wabaTemplateId !== mt.id) {
          skipped.push({ name: mt.name, reason: 'Meta template identity changed. Review and reconnect this template before use.' });
          await db.update(whatsappTemplatesTable).set({
            status: 'DRAFT', hasLocalChanges: true, submissionStatus: 'identity_conflict',
            metaRejectionReason: 'Meta template identity changed. Review the connected business account and template binding.',
            updatedAt: nextTemplateRevision(existing[0].updatedAt),
          }).where(and(eq(whatsappTemplatesTable.id, existing[0].id), eq(whatsappTemplatesTable.userId, userId), revisionMatches(existing[0].revision)));
          continue;
        }
        if (templateSubmissionLeaseActive(existing[0])) {
          skipped.push({ name: mt.name, reason: 'Submission is in progress. Sync again after it finishes.' });
          continue;
        }
        const rawOtp = buttonComponents[0]?.buttons?.[0];
        const existingAuth = existing[0].authConfig as AuthenticationConfig | null;
        const authConfig = mt.category === 'AUTHENTICATION' ? {
          otpType: rawOtp?.otp_type || existingAuth?.otpType || 'COPY_CODE',
          buttonText: rawOtp?.text || existingAuth?.buttonText || 'Copy code',
          addSecurityRecommendation: bodyComponent?.add_security_recommendation ?? existingAuth?.addSecurityRecommendation ?? false,
          codeExpirationMinutes: footerComponent?.code_expiration_minutes || existingAuth?.codeExpirationMinutes || 10,
          ...(rawOtp?.supported_apps?.[0] ? { packageName: rawOtp.supported_apps[0].package_name, signatureHash: rawOtp.supported_apps[0].signature_hash, autofillText: rawOtp.autofill_text || 'Autofill' }
            : existingAuth?.otpType === 'ONE_TAP' ? { packageName: existingAuth.packageName, signatureHash: existingAuth.signatureHash, autofillText: existingAuth.autofillText } : {}),
        } : null;
        const providerContent = {
          category: mt.category, authConfig,
          status: mt.status,
          body: bodyComponent?.text || '',
          header: headerText,
          headerType,
          headerMediaUrl,
          footer: footerComponent?.text || null,
          buttons: mt.category === 'AUTHENTICATION' ? null : buttons.length > 0 ? buttons : null,
          examples: Object.keys(metaExamples).length > 0 ? metaExamples : null,
          hasLocalChanges: false,
        };
        const recovering = ['submitting', 'submission_uncertain'].includes(existing[0].submissionStatus);
        const submitted = existing[0].submittedSnapshot as Record<string, unknown> | null;
        const mediaHeader = ['IMAGE','VIDEO','DOCUMENT'].includes(headerType);
        const mediaReceiptMatches = !mediaHeader || Boolean(submitted?.headerMediaUrl && submitted.headerMediaUrl === providerContent.headerMediaUrl);
        // Inferred localized OTP settings are useful for previewing imported
        // templates, but cannot prove an uncertain write reached Meta. Only
        // explicit provider fields may release that submission protection.
        const authReceiptMatches = mt.category !== 'AUTHENTICATION' || Boolean(
          typeof bodyComponent?.add_security_recommendation === 'boolean'
          && Number.isInteger(footerComponent?.code_expiration_minutes)
          && rawOtp?.otp_type,
        );
        const preserveLocal = existing[0].hasLocalChanges
          && !(recovering && mediaReceiptMatches && authReceiptMatches && templateContentMatches(existing[0], providerContent));
        // A Meta example upload handle cannot render in the local preview. Keep
        // the owned source URL for a matching header rather than replacing it.
        const approvedProviderSnapshot = templateSnapshot({ ...existing[0], ...providerContent });
        if (!preserveLocal && (!submitted || mediaReceiptMatches) && mediaHeader && existing[0].headerType === headerType && existing[0].headerMediaUrl
            && !/^https?:\/\//.test(String(providerContent.headerMediaUrl || ''))) {
          providerContent.headerMediaUrl = existing[0].headerMediaUrl;
        }
        const syncState = {
          wabaTemplateId: mt.id,
          metaStatus: mt.status,
          submissionStatus: preserveLocal ? (recovering ? 'submission_uncertain' : 'local_draft') : providerTemplateSubmissionStatus(String(mt.status || '')),
          metaRejectionReason: whatsappTemplateRejectionReason(mt.rejected_reason),
          lastSyncedAt: new Date(),
          activityHistory: templateActivity(existing[0], 'status_refreshed', { ...existing[0], ...providerContent }, String(mt.status || 'PENDING')),
          approvedSnapshot: String(mt.status).toUpperCase() === 'APPROVED' ? (preserveLocal ? approvedProviderSnapshot : templateSnapshot({ ...existing[0], ...providerContent })) : existingApprovedSnapshot(existing[0]),
          updatedAt: nextTemplateRevision(existing[0].updatedAt),
        };
        const updated = await db.update(whatsappTemplatesTable).set({ ...syncState,
          ...(preserveLocal ? { status: 'DRAFT' } : providerContent),
        }).where(and(eq(whatsappTemplatesTable.id, existing[0].id), eq(whatsappTemplatesTable.userId, userId),
          revisionMatches(existing[0].revision))).returning(templateRevisionSelection);
        if (!updated.length) {
          skipped.push({ name: mt.name, reason: 'A concurrent edit was preserved. Sync again to refresh status.' });
          continue;
        }
      } else {
        const imported = {
          userId,
          name: mt.name,
          language: mt.language,
          category: mt.category,
          authConfig: mt.category === 'AUTHENTICATION' ? {
            otpType: buttonComponents[0]?.buttons?.[0]?.otp_type || 'COPY_CODE',
            buttonText: buttonComponents[0]?.buttons?.[0]?.text || 'Copy code',
            addSecurityRecommendation: bodyComponent?.add_security_recommendation ?? false,
            codeExpirationMinutes: footerComponent?.code_expiration_minutes || 10,
            ...(buttonComponents[0]?.buttons?.[0]?.supported_apps?.[0] ? {
              packageName: buttonComponents[0].buttons[0].supported_apps[0].package_name,
              signatureHash: buttonComponents[0].buttons[0].supported_apps[0].signature_hash,
              autofillText: buttonComponents[0].buttons[0].autofill_text || 'Autofill',
            } : {}),
          } : null,
          status: mt.status,
          metaStatus: mt.status,
          submissionStatus: providerTemplateSubmissionStatus(String(mt.status || '')),
          metaRejectionReason: whatsappTemplateRejectionReason(mt.rejected_reason),
          wabaTemplateId: mt.id,
          body: bodyComponent?.text || '',
          header: headerText,
          headerType,
          headerMediaUrl,
          footer: footerComponent?.text || null,
          buttons: mt.category === 'AUTHENTICATION' ? null : buttons.length > 0 ? buttons : null,
          examples: Object.keys(metaExamples).length > 0 ? metaExamples : null,
          hasLocalChanges: false,
          lastSyncedAt: new Date(),
        };
        await db.insert(whatsappTemplatesTable).values({ ...imported, activityHistory: templateActivity(null, 'status_refreshed', imported, String(mt.status || 'PENDING')), approvedSnapshot: String(mt.status).toUpperCase() === 'APPROVED' ? templateSnapshot(imported) : null });
      }
      synchronized += 1;
    }

    if (refreshId) {
      const [template] = await db.select(templateRevisionSelection).from(whatsappTemplatesTable).where(and(eq(whatsappTemplatesTable.id, refreshId), eq(whatsappTemplatesTable.userId, userId))).limit(1);
      if (!synchronized) return res.status(409).json({ error: skipped[0]?.reason || 'Meta has not returned this template yet. Its previous submission remains protected; check again before retrying.' });
      return res.json({ success: true, template });
    }
    return res.json({ success: true, count: synchronized, skipped });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WhatsAppTemplateController] Error syncing templates');
    res.status(500).json({ error: 'Failed to sync templates' });
  }
}
