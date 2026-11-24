import {
  rebuildKnowledgeBaseEmbeddings,
  verifyKnowledgeBaseEmbeddings,
} from '../services/KnowledgeBaseEmbeddingRepairService.js';

const args = new Set(process.argv.slice(2));
const userArg = process.argv.find((value) => value.startsWith('--user-id='));
const userId = userArg ? Number(userArg.split('=')[1]) : undefined;
if (userId !== undefined && (!Number.isSafeInteger(userId) || userId <= 0)) {
  throw new Error('--user-id must be a positive integer.');
}

const result = args.has('--verify-only')
  ? await verifyKnowledgeBaseEmbeddings(userId)
  : await rebuildKnowledgeBaseEmbeddings({ userId, onlyMissing: args.has('--only-missing') });

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if ('failed' in result && result.failed.length > 0) process.exitCode = 1;
if ('missingEntryIds' in result && result.missingEntryIds.length > 0) process.exitCode = 2;
