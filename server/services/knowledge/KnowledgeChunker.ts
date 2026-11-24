import { extractExactIdentifiers, scanKnowledgeContent } from './KnowledgePrivacyService.js';
import { boundKnowledgeText, knowledgeTokenCount, KNOWLEDGE_MAX_CHUNK_BYTES } from './KnowledgePayloadSafety.js';

export interface StructuredKnowledgeChunk {
  ordinal: number;
  displayText: string;
  searchText: string;
  charStart: number;
  charEnd: number;
  tokenCount: number;
  sectionPath: string[];
  pageNumber?: number;
  exactIdentifiers: string[];
  injectionFlags: string[];
}

interface WordToken {
  start: number;
  end: number;
}

function normalizeDocumentText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\u0000').join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function tokenize(text: string): WordToken[] {
  return Array.from(text.matchAll(/\S+/g)).flatMap(match => {
    const start = match.index || 0;
    if (match[0].length <= 16) return [{ start, end: start + match[0].length }];
    // Long unspaced runs (including CJK) must have usable split boundaries.
    const parts: WordToken[] = [];
    let offset = start;
    for (const character of match[0]) {
      parts.push({ start: offset, end: offset + character.length });
      offset += character.length;
    }
    return parts;
  });
}

function findSectionPath(text: string, offset: number): string[] {
  const prefix = text.slice(0, offset);
  const headings = Array.from(prefix.matchAll(/^(#{1,6})\s+(.+)$/gm));
  const path: string[] = [];
  for (const heading of headings) {
    const depth = heading[1].length;
    path.splice(depth - 1);
    path[depth - 1] = heading[2].trim().slice(0, 255);
  }
  return path.filter(Boolean);
}

function findPageNumber(text: string, offset: number): number | undefined {
  const formFeeds = text.slice(0, offset).match(/\f/g)?.length || 0;
  return formFeeds > 0 || text.includes('\f') ? formFeeds + 1 : undefined;
}

function chooseBoundary(text: string, tokens: WordToken[], start: number, proposedEnd: number): number {
  if (proposedEnd >= tokens.length) return tokens.length;
  const earliest = start + Math.floor((proposedEnd - start) * 0.7);
  for (let index = proposedEnd; index > earliest; index -= 1) {
    const between = text.slice(tokens[index - 1].end, tokens[index]?.start ?? tokens[index - 1].end);
    if (/\n\n|\f/.test(between) || /[.!?]\s*$/.test(text.slice(tokens[index - 1].start, tokens[index - 1].end))) {
      return index;
    }
  }
  return proposedEnd;
}

export function chunkStructuredKnowledge(
  input: string,
  options: { targetTokens?: number; overlapTokens?: number; maxChunks?: number; trustedBusinessContacts?: readonly string[] } = {},
): StructuredKnowledgeChunk[] {
  const targetTokens = options.targetTokens ?? 600;
  const overlapTokens = options.overlapTokens ?? 100;
  const maxChunks = options.maxChunks ?? 10_000;
  if (!Number.isInteger(targetTokens) || targetTokens < 100 || targetTokens > 2_000) {
    throw new Error('targetTokens must be an integer between 100 and 2000.');
  }
  if (!Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= targetTokens) {
    throw new Error('overlapTokens must be an integer greater than or equal to 0 and smaller than targetTokens.');
  }

  const text = normalizeDocumentText(input);
  const tokens = tokenize(text);
  if (!tokens.length) return [];

  const chunks: StructuredKnowledgeChunk[] = [];
  // Exact, invocation-local keys avoid repeatedly encoding overlapping/repeated
  // document text without retaining private source text in a process-wide cache.
  const measured = new Map<string, number>();
  const count = (value: string) => {
    const existing = measured.get(value);
    if (existing !== undefined) return existing;
    const tokens = knowledgeTokenCount(value);
    if (measured.size < 1_000) measured.set(value, tokens);
    return tokens;
  };
  let tokenStart = 0;
  while (tokenStart < tokens.length) {
    const proposedEnd = Math.min(tokens.length, tokenStart + targetTokens);
    let tokenEnd = chooseBoundary(text, tokens, tokenStart, proposedEnd);
    if (tokenEnd <= tokenStart) throw new Error('Knowledge chunker did not make forward progress.');
    if (chunks.length >= maxChunks) throw new Error(`Document exceeds the maximum of ${maxChunks} chunks.`);

    const charStart = tokens[tokenStart].start;
    const sectionPath = findSectionPath(text, charStart)
      .map(heading => scanKnowledgeContent(heading, options))
      .filter(scan => !scan.mustQuarantine)
      .map(scan => boundKnowledgeText(scan.searchText, Math.max(8, Math.floor(targetTokens / 12)), 256));
    const contextualPrefix = sectionPath.length
      ? `${boundKnowledgeText(sectionPath.join(' > '), Math.floor(targetTokens / 3), 1_000)}\n` : '';
    while (tokenEnd > tokenStart + 1) {
      const candidate = scanKnowledgeContent(`${contextualPrefix}${text.slice(charStart, tokens[tokenEnd - 1].end)}`, options).searchText;
      if (Buffer.byteLength(candidate, 'utf8') <= KNOWLEDGE_MAX_CHUNK_BYTES && count(candidate) <= targetTokens) break;
      tokenEnd = tokenStart + Math.max(1, Math.floor((tokenEnd - tokenStart) * 0.8));
    }
    const charEnd = tokens[tokenEnd - 1].end;
    const raw = text.slice(charStart, charEnd).trim();
    const scan = scanKnowledgeContent(raw, options);
    const searchScan = scanKnowledgeContent(`${contextualPrefix}${scan.searchText}`, options);
    const actualTokens = count(searchScan.searchText);
    if (actualTokens > targetTokens || Buffer.byteLength(searchScan.searchText, 'utf8') > KNOWLEDGE_MAX_CHUNK_BYTES) {
      throw new Error('Knowledge chunk exceeds the safe payload budget after redaction.');
    }
    chunks.push({
      ordinal: chunks.length,
      // Search and display representations are deliberately de-identified;
      // the encrypted source remains in tenant-scoped object storage.
      displayText: scan.searchText,
      searchText: searchScan.searchText,
      charStart,
      charEnd,
      tokenCount: actualTokens,
      sectionPath,
      pageNumber: findPageNumber(text, charStart),
      exactIdentifiers: [...new Set([...scan.exactIdentifiers, ...extractExactIdentifiers(raw)])],
      injectionFlags: scan.injectionFlags,
    });

    if (tokenEnd >= tokens.length) break;
    const nextStart = Math.max(tokenStart + 1, tokenEnd - overlapTokens);
    if (nextStart <= tokenStart) throw new Error('Knowledge chunker did not make forward progress.');
    tokenStart = nextStart;
  }
  return chunks;
}
