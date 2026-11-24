import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const serverRoot = path.resolve(import.meta.dirname, '..');

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (['node_modules', 'dist', 'coverage'].includes(entry)) return [];
    const absolute = path.join(directory, entry);
    return statSync(absolute).isDirectory() ? files(absolute) : /\.tsx?$/.test(entry) ? [absolute] : [];
  });
}

const scanRoots = ['controllers', 'services', 'mastra', 'routes'].map((root) => path.join(serverRoot, root));
const allowedLegacyImports = new Set([
  'controllers/knowledgeBaseController.ts',
  'services/booking/HotelRagSyncService.ts',
  'services/knowledge/KnowledgeGateway.ts',
  'services/agents/BaseOutreachAgent.ts',
]);
const allowedRawTables = new Set([
  'services/KnowledgeBaseService.ts',
  'services/KnowledgeBaseEmbeddingRepairService.ts',
  'services/embeddings/EmbeddingService.ts',
  'services/RAGFAQResponder.ts',
  'controllers/knowledgeBaseController.ts',
]);
const lifecycleServices = new Set([
  'services/knowledge/KnowledgeGovernanceService.ts',
  'services/knowledge/KnowledgeIngestionService.ts',
]);

const violations: Array<{ file: string; rule: string }> = [];
for (const absolute of scanRoots.flatMap(files)) {
  const relative = path.relative(serverRoot, absolute).split(path.sep).join('/');
  const source = readFileSync(absolute, 'utf8');
  if (/KnowledgeBaseService(?:\.js)?['"]/.test(source) && !allowedLegacyImports.has(relative)) {
    violations.push({ file: relative, rule: 'legacy-service-import' });
  }
  if (/knowledgeBaseService\.(?:getSemanticContext|getGroundedContext|getKnowledgeContext|getCondensedSummary|searchByKeywords|findMatchingFAQ)\s*\(/.test(source)) {
    violations.push({ file: relative, rule: 'legacy-retrieval-call' });
  }
  // Ingestion/deletion may lock the legacy row ID to prevent resurrection and
  // remove it transactionally. They still cannot retrieve raw content for AI.
  const retrievalSource = lifecycleServices.has(relative) ? source
    .replace(/\bSELECT\s+id\s+FROM\s+knowledge_base\b/gi, 'LOCK_LEGACY_ID')
    .replace(/\bDELETE\s+FROM\s+knowledge_base\b/gi, 'DELETE_LEGACY_ROW') : source;
  if (/\b(?:FROM|JOIN)\s+knowledge_base(?:_embeddings)?\b/i.test(retrievalSource) && !allowedRawTables.has(relative)) {
    violations.push({ file: relative, rule: 'raw-knowledge-table-read' });
  }
}

const embeddingRoutes = readFileSync(path.join(serverRoot, 'routes/embeddings.routes.ts'), 'utf8');
for (const endpoint of ['/generate', '/store', '/search', '/source/']) {
  const escaped = endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`router\\.(?:post|delete)\\(\\s*['"]${escaped}`).test(embeddingRoutes)) {
    violations.push({ file: 'routes/embeddings.routes.ts', rule: `raw-embedding-route:${endpoint}` });
  }
}

const specialists = ['TechSupportAgent.ts', 'GeneralServiceAgent.ts', 'LeadQualifierAgent.ts', 'CustomerSuccessAgent.ts', 'HotelSalesAgent.ts'];
for (const specialist of specialists) {
  const relative = `services/agents/${specialist}`;
  const source = readFileSync(path.join(serverRoot, relative), 'utf8');
  if (/getSemanticContext|getGroundedContext|KnowledgeBaseService/.test(source)) {
    violations.push({ file: relative, rule: 'specialist-direct-retrieval' });
  }
}

process.stdout.write(`${JSON.stringify({
  generatedAt: new Date().toISOString(),
  canonicalGateway: 'services/knowledge/KnowledgeGateway.ts',
  violations,
}, null, 2)}\n`);
if (violations.length > 0) process.exitCode = 1;
