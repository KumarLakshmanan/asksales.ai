import path from 'path';
import { parse as parseCsv } from 'csv-parse/sync';
import * as XLSX from '@e965/xlsx';
import { logger } from '../utils/logger.js';
import { scanKnowledgeContent } from './knowledge/KnowledgePrivacyService.js';

export interface IngestionChunk {
  index: number;
  text: string;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
  embedding?: number[];
}

export interface IngestionResult {
  extractedText: string;
  chunks: IngestionChunk[];
  embeddingModel?: string;
  embeddingProvider?: string;
  embeddingsGenerated: boolean;
  extractionSource: string;
  extractionWarnings: string[];
}

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 200;
const MIN_CHUNK_SIZE = 200;
const MAX_CHUNK_SIZE = 8_000;
const MAX_CHUNKS_PER_DOCUMENT = 10_000;
const MAX_OFFICE_ARCHIVE_ENTRIES = 2_000;
const MAX_OFFICE_EXPANDED_BYTES = 25 * 1024 * 1024;
const MAX_TABULAR_ROWS = 5_000;
const MAX_TABULAR_COLUMNS = 200;
const EXTRACTION_TIMEOUT_MS = 12_000;

function assertSafeOfficeArchive(buffer: Buffer): void {
  let offset = 0;
  let entries = 0;
  let totalCompressed = 0;
  let totalExpanded = 0;

  while (offset <= buffer.length - 46) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    entries += 1;
    const compressed = buffer.readUInt32LE(offset + 20);
    const expanded = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    totalCompressed += compressed;
    totalExpanded += expanded;
    if (
      entries > MAX_OFFICE_ARCHIVE_ENTRIES ||
      totalExpanded > MAX_OFFICE_EXPANDED_BYTES ||
      (totalCompressed > 0 && totalExpanded / totalCompressed > 100)
    ) {
      throw new Error('Office document exceeds safe extraction limits');
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  if (entries === 0) {
    throw new Error('Office document archive is invalid');
  }
}

async function withExtractionTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Document extraction timed out')),
          EXTRACTION_TIMEOUT_MS,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[ \u00A0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function chunkKnowledgeText(text: string, chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_CHUNK_OVERLAP): IngestionChunk[] {
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
    throw new Error(`chunkSize must be an integer between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE}.`);
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
    throw new Error('chunkOverlap must be an integer greater than or equal to 0 and smaller than chunkSize.');
  }
  const clean = normalizeWhitespace(text);
  if (!clean) return [];

  const chunks: IngestionChunk[] = [];
  let start = 0;
  let index = 0;

  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);

    if (end < clean.length) {
      const nearestBoundary = Math.max(
        clean.lastIndexOf('\n\n', end),
        clean.lastIndexOf('\n', end),
        clean.lastIndexOf('. ', end),
      );
      if (nearestBoundary > start + Math.floor(chunkSize * 0.55)) {
        end = nearestBoundary + 1;
      }
    }

    const slice = clean.slice(start, end).trim();
    if (slice) {
      if (chunks.length >= MAX_CHUNKS_PER_DOCUMENT) {
        throw new Error(`Document exceeds the maximum of ${MAX_CHUNKS_PER_DOCUMENT} chunks.`);
      }
      chunks.push({
        index,
        text: slice,
        charStart: start,
        charEnd: end,
        tokenEstimate: Math.ceil(slice.length / 4),
      });
      index += 1;
    }

    if (end >= clean.length) break;
    const nextStart = Math.max(0, end - overlap);
    if (nextStart <= start) throw new Error('Knowledge-base chunking did not make forward progress.');
    start = nextStart;
  }

  return chunks;
}

async function extractFromPdf(buffer: Buffer): Promise<string> {
  const mod = await import('pdf-parse');
  const parsePdf = (
    'default' in mod ? mod.default : mod
  ) as (input: Buffer) => Promise<{ text?: string }>;
  const parsed = await withExtractionTimeout(parsePdf(buffer));
  return parsed?.text || '';
}

async function extractFromDocx(buffer: Buffer): Promise<string> {
  assertSafeOfficeArchive(buffer);
  const mod = await import('mammoth');
  const mammoth = (
    'default' in mod ? mod.default : mod
  ) as { extractRawText: (input: { buffer: Buffer }) => Promise<{ value?: string }> };
  const result = await withExtractionTimeout(mammoth.extractRawText({ buffer }));
  return result?.value || '';
}

function extractFromSpreadsheet(buffer: Buffer, officeArchive: boolean): string {
  if (officeArchive) assertSafeOfficeArchive(buffer);
  const wb = XLSX.read(buffer, { type: 'buffer', sheetRows: MAX_TABULAR_ROWS + 1 });
  const output: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
      defval: '',
      range: 0,
    }).slice(0, MAX_TABULAR_ROWS).map((row) =>
      Object.fromEntries(Object.entries(row).slice(0, MAX_TABULAR_COLUMNS)),
    );
    output.push(`Sheet: ${sheetName}`);
    output.push(JSON.stringify(rows, null, 2));
  }
  return output.join('\n\n');
}

function extractFromCsv(buffer: Buffer): string {
  const content = buffer.toString('utf8');
  const parsedRows = parseCsv(content, {
    columns: true,
    skip_empty_lines: true,
    to: MAX_TABULAR_ROWS + 1,
    max_record_size: 1_000_000,
  }) as unknown[];
  const rows = parsedRows.slice(0, MAX_TABULAR_ROWS).map((row) => {
    const record = row && typeof row === 'object' && !Array.isArray(row)
      ? row as Record<string, unknown>
      : {};
    return Object.fromEntries(Object.entries(record).slice(0, MAX_TABULAR_COLUMNS));
  });
  return JSON.stringify(rows, null, 2);
}

async function extractTextByMime(buffer: Buffer, mimeType: string, fileName: string): Promise<{ text: string; source: string; warnings: string[] }> {
  const ext = path.extname(fileName).toLowerCase();
  const warnings: string[] = [];

  try {
    if (mimeType === 'application/pdf' || ext === '.pdf') {
      return { text: await extractFromPdf(buffer), source: 'pdf-loader', warnings };
    }

    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      ext === '.docx'
    ) {
      return { text: await extractFromDocx(buffer), source: 'docx-loader', warnings };
    }

    if (
      mimeType === 'text/csv' ||
      ext === '.csv'
    ) {
      return { text: extractFromCsv(buffer), source: 'csv-loader', warnings };
    }

    if (mimeType === 'application/vnd.ms-excel' || ext === '.xls') {
      return { text: extractFromSpreadsheet(buffer, false), source: 'xls-loader', warnings };
    }

    if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || ext === '.xlsx') {
      return { text: extractFromSpreadsheet(buffer, true), source: 'xlsx-loader', warnings };
    }

    if (
      mimeType === 'text/plain' ||
      mimeType === 'application/json' ||
      ext === '.txt' ||
      ext === '.md' ||
      ext === '.json'
    ) {
      return { text: buffer.toString('utf8'), source: 'text-loader', warnings };
    }

    if (
      mimeType === 'application/msword' ||
      mimeType === 'application/vnd.ms-powerpoint' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      ext === '.doc' || ext === '.ppt' || ext === '.pptx'
    ) {
      warnings.push('This file format has limited extraction support in the current server setup.');
      return { text: '', source: 'unsupported-loader', warnings };
    }

    warnings.push('No dedicated extractor found for this file type.');
    return { text: '', source: 'unknown-loader', warnings };
  } catch (error: unknown) {
    logger.error({ err: error, fileName, mimeType }, '[KnowledgeBaseIngestion] Extraction error');
    warnings.push('Failed to extract text from the uploaded file.');
    return { text: '', source: 'error-loader', warnings };
  }
}

/**
 * Extract text for an authenticated, one-off conversation attachment.
 *
 * This deliberately skips chunk embeddings and therefore never calls an AI
 * provider. Conversation attachments use it to give the active agent bounded
 * document context while keeping the durable file in tenant-scoped storage.
 */
export async function extractTextForConversationContext(params: {
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
}): Promise<{ text: string; source: string; warnings: string[] }> {
  const extracted = await extractTextByMime(
    params.fileBuffer,
    params.mimeType,
    params.fileName,
  );
  return {
    ...extracted,
    text: normalizeWhitespace(extracted.text || ''),
  };
}

async function generateEmbeddingsForChunks(userId: number, chunks: IngestionChunk[]): Promise<{
  chunks: IngestionChunk[];
  generated: boolean;
  provider?: string;
  model?: string;
}> {
  if (!chunks.length) return { chunks, generated: false };

  try {
    const { embeddingService } = await import('./embeddings/EmbeddingService.js');
    // Embedding providers receive only de-identified search representations.
    const chunkTexts = chunks.map((chunk) => scanKnowledgeContent(chunk.text).searchText);
    
    // Process in smaller batches to avoid overwhelming the provider or hitting limits
    const maxBatchSize = 100;
    let allVectors: number[][] = [];
    let usedProvider = '';
    let usedModel = '';
    
    for (let i = 0; i < chunkTexts.length; i += maxBatchSize) {
      const batchTexts = chunkTexts.slice(i, i + maxBatchSize);
      const batchResult = await embeddingService.generateEmbeddingsBatch(batchTexts, userId);
      
      allVectors = allVectors.concat(batchResult.vectors);
      if (!usedProvider) usedProvider = batchResult.provider;
      if (!usedModel) usedModel = batchResult.model;
    }

    const enriched = chunks.map((chunk, idx) => ({
      ...chunk,
      embedding: allVectors[idx],
    }));

    return { chunks: enriched, generated: true, provider: usedProvider, model: usedModel };
  } catch (error: unknown) {
    logger.error({ err: error, userId }, '[KnowledgeBaseIngestion] Embedding generation error via EmbeddingService');
    return { chunks, generated: false };
  }
}

export async function ingestKnowledgeBaseFile(params: {
  userId: number;
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
  generateEmbeddings?: boolean;
}): Promise<IngestionResult> {
  const { userId, fileBuffer, fileName, mimeType } = params;

  const extracted = await extractTextByMime(fileBuffer, mimeType, fileName);
  const normalizedText = normalizeWhitespace(extracted.text || '');
  if (extracted.source === 'unsupported-loader' || extracted.source === 'unknown-loader') {
    throw new Error(`Unsupported knowledge-base file format: ${path.extname(fileName).toLowerCase() || mimeType}`);
  }
  if (!normalizedText) {
    throw new Error(
      extracted.source === 'pdf-loader'
        ? 'No searchable text was extracted from this PDF. OCR is required for scanned documents.'
        : 'No searchable text was extracted from the uploaded document.',
    );
  }

  // Resolve chunk settings from the active embedding credential config (admin-configured).
  let chunkSize = DEFAULT_CHUNK_SIZE;
  let chunkOverlap = DEFAULT_CHUNK_OVERLAP;
  if (params.generateEmbeddings !== false) try {
    const { embeddingService } = await import('./embeddings/EmbeddingService.js');
    const { provider } = await embeddingService.resolveProviderAndModel();
    const cred = await embeddingService.getCredential(provider);
    if (cred?.config) {
      if (typeof cred.config.chunkSize === 'number') chunkSize = cred.config.chunkSize;
      if (typeof cred.config.chunkOverlap === 'number') chunkOverlap = cred.config.chunkOverlap;
    }
  } catch (err) {
    logger.warn({ err }, '[KBIngestion] Could not load chunk config from credential, using defaults');
  }

  const baseChunks = chunkKnowledgeText(normalizedText, chunkSize, chunkOverlap);
  const privacy = scanKnowledgeContent(normalizedText);
  const embedded = privacy.mustQuarantine || params.generateEmbeddings === false
    ? { chunks: baseChunks, generated: false as const, provider: undefined, model: undefined }
    : await generateEmbeddingsForChunks(userId, baseChunks);

  return {
    extractedText: normalizedText,
    chunks: embedded.chunks,
    embeddingModel: embedded.generated ? embedded.model : undefined,
    embeddingProvider: embedded.generated ? embedded.provider : undefined,
    embeddingsGenerated: embedded.generated,
    extractionSource: extracted.source,
    extractionWarnings: [
      ...extracted.warnings,
      ...(privacy.mustQuarantine ? [`Privacy/integrity scan requires quarantine: ${privacy.reasons.join(', ')}`] : []),
    ],
  };
}
