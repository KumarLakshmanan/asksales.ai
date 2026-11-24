import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const serverRoot = path.resolve(import.meta.dirname, '..');
const workspaceRoot = path.resolve(serverRoot, '..');

const expectedStages = [
  'HandoffPolicyStage', 'PrivacyStage', 'ConversationContextStage', 'OptOutStage', 'ConversationModeStage',
  'AgentConfigurationStage', 'PreGenerationPolicyStage', 'RateLimitStage',
  // AssistantAvailability.ts requires the mandatory safety/ownership checks
  // before away replies, and must gate playbooks and generation outside hours.
  // Added with assistant routing in a354c6d7; see ASSISTANTS_ROLLOUT.md.
  'InboundGuardrailStage', 'AssistantAvailabilityStage', 'HandoffConsentStage', 'ActivePlaybookSelectionStage',
  'CustomerCourtesyStage', 'IntentRiskClassifierStage', 'SemanticOptOutStage', 'SentimentStage',
  'TicketAwareHandoffStage', 'PostClassificationPolicyStage', 'CanAIHandleGate', 'CustomerHistoryStage', 'PlaybookStage', 'ExternalContentEnrichmentStage',
  'KnowledgeRetrievalStage', 'DocumentRetrievalStage', 'MediaRetrievalStage', 'AgentDispatchStage',
  'HandoffOfferStage', 'TicketAwareResponseStage', 'ReplyLanguageStage', 'GuardrailComplianceStage', 'MediaSelectionStage',
  'PlaybookComplianceStage', 'ConfidenceGate', 'DecisionAuditStage', 'DeliveryStage',
  'PostProcessingStage', 'AuditStage',
];

const quarantine: Record<string, string[]> = {
  'agents/AgentDecision.ts': [],
  'agents/index.ts': [],
  'models/agents/schema.ts': ['models/agents/functions.ts', 'models/allSchemas.ts', 'models/index.ts'],
  'models/agents/functions.ts': ['models/index.ts'],
  'models/subAgentConfigs/schema.ts': ['models/allSchemas.ts', 'models/index.ts'],
  'services/RAGFAQResponder.ts': [],
  'services/agents/LeadDeduplicationService.ts': [],
  'services/agents/StreamingService.ts': [],
};

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (['node_modules', 'dist', 'coverage'].includes(entry)) return [];
    const absolute = path.join(directory, entry);
    return statSync(absolute).isDirectory()
      ? listTypeScriptFiles(absolute)
      : /\.(?:ts|tsx)$/.test(entry) ? [absolute] : [];
  });
}

function resolveImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const raw = path.resolve(path.dirname(importer), specifier);
  const candidates = [raw, raw.replace(/\.js$/, '.ts'), `${raw}.ts`, path.join(raw, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

const files = listTypeScriptFiles(serverRoot);
const importers = new Map<string, Set<string>>();
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const matches = source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g);
  for (const match of matches) {
    const resolved = resolveImport(file, match[1]);
    if (!resolved) continue;
    const target = path.relative(serverRoot, resolved).split(path.sep).join('/');
    const importing = path.relative(serverRoot, file).split(path.sep).join('/');
    const set = importers.get(target) || new Set<string>();
    set.add(importing);
    importers.set(target, set);
  }
}

const gateway = readFileSync(path.join(serverRoot, 'services/agents/pipeline/ChannelGateway.ts'), 'utf8');
// Inspect the ordered pipeline declaration, not separately invoked recovery
// stages in process(). A missing declaration must still fail the drift check.
const pipelineDeclaration = gateway.match(/private\s+stages\s*:\s*PipelineStage\[\]\s*=\s*\[([\s\S]*?)\];/)?.[1] || '';
const actualStages = [...pipelineDeclaration.matchAll(/new\s+([A-Za-z0-9_]+(?:Stage|Gate))\s*\(/g)].map((match) => match[1]);
const stageDrift = JSON.stringify(actualStages) !== JSON.stringify(expectedStages);

const quarantineReport = Object.entries(quarantine).map(([candidate, allowed]) => {
  const actual = [...(importers.get(candidate) || new Set<string>())].sort();
  const unexpected = actual.filter((importer) => !allowed.includes(importer));
  return { candidate, allowedImporters: allowed, actualImporters: actual, unexpected };
});

const trackedArtifacts = execFileSync('git', ['ls-files'], { cwd: workspaceRoot, encoding: 'utf8' })
  .split('\n')
  .filter((file) => /(^|\/)\.DS_Store$|\.tsbuildinfo$|eslint-report\.json$|ts-errors\.log$/.test(file));

const report = {
  generatedAt: new Date().toISOString(),
  activeAgentInvariant: 'exactly_one_per_tenant',
  stages: actualStages,
  stageDrift,
  quarantinedLegacyCandidates: quarantineReport,
  trackedGeneratedArtifacts: trackedArtifacts,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (stageDrift || trackedArtifacts.length || quarantineReport.some((item) => item.unexpected.length)) {
  process.exitCode = 1;
}
