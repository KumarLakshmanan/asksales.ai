import {and,desc,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {db} from '../../models/db.js';
import {storageFilesTable} from '../../models/storageFiles/schema.js';
import {requireBusinessScope} from '../../tenancy/businessContext.js';
import {createContactAnalysis,DashboardOperationError} from './DashboardOperations.js';
import {contactAnalysisOptionsSchema,operationRequestKeySchema} from './ContactAnalysisValidation.js';

export const storedContactAnalysisSchema=z.object({
  fileIds:z.array(z.number().int().positive()).min(1).max(20).refine(ids=>new Set(ids).size===ids.length,'Choose each stored file once.'),
  options:contactAnalysisOptionsSchema.default({defaultCountry:'none'}),requestKey:operationRequestKeySchema,
}).strict();
export const storedWorkbookListSchema=z.object({search:z.string().trim().max(120).optional(),beforeId:z.number().int().positive().optional()}).strict();

/** IDs resolve through private managed storage; paths and remote URLs are never accepted. */
export async function analyzeStoredContactWorkbooks(input:z.infer<typeof storedContactAnalysisSchema>) {
  input=storedContactAnalysisSchema.parse(input);
  const {userId,businessProfileId}=requireBusinessScope();
  const {storageService}=await import('../StorageService.js');
  const sources=[];
  let bytes=0;
  // Check the entire metadata budget before downloading the first object.
  for(const id of input.fileIds) {
    const file=await storageService.getFile(id,userId);
    if(!file || file.businessProfileId!==businessProfileId)throw new DashboardOperationError('One or more contact files were not found.',404);
    const name=file.originalName || file.fileName;
    if(!/\.(xlsx|xls|csv|tsv)$/i.test(name))throw new DashboardOperationError('Choose Excel, CSV or TSV contact files.');
    const size=Number(file.fileSizeBytes);
    if(!Number.isSafeInteger(size) || size<1 || size>25*1024*1024 || (bytes+=size)>100*1024*1024)throw new DashboardOperationError('Contact files must be at most 25 MB each and 100 MB combined.');
    sources.push(file);
  }
  const files=[];
  for(const file of sources) {
    const source=await storageService.downloadFile(file.id,userId);
    if(!source || source.file.businessProfileId!==businessProfileId || source.file.updatedAt.getTime()!==file.updatedAt.getTime()
      || source.buffer.length!==Number(file.fileSizeBytes))throw new DashboardOperationError('A source file changed. Choose the files again.',409);
    files.push({name:file.originalName || file.fileName,buffer:source.buffer});
  }
  return createContactAnalysis(files,input.options,input.requestKey);
}

export async function listStoredContactWorkbooks(input:z.infer<typeof storedWorkbookListSchema>) {
  input=storedWorkbookListSchema.parse(input);
  const {userId,businessProfileId}=requireBusinessScope();
  const rows=await db.select({id:storageFilesTable.id,name:sql<string>`coalesce(${storageFilesTable.originalName},${storageFilesTable.fileName})`,
    bytes:storageFilesTable.fileSizeBytes,createdAt:storageFilesTable.createdAt}).from(storageFilesTable).where(and(
    eq(storageFilesTable.userId,userId),eq(storageFilesTable.businessProfileId,businessProfileId),eq(storageFilesTable.isDeleted,false),
    sql`${storageFilesTable.metadata} #>> '{storageWorkspace,trashedAt}' IS NULL`,
    sql`coalesce(${storageFilesTable.originalName},${storageFilesTable.fileName}) ~* '[.](xlsx|xls|csv|tsv)$'`,
    input.beforeId ? sql`${storageFilesTable.id}<${input.beforeId}` : undefined,
    input.search ? sql`strpos(lower(coalesce(${storageFilesTable.originalName},${storageFilesTable.fileName})),lower(${input.search}))>0` : undefined,
  )).orderBy(desc(storageFilesTable.id)).limit(21);
  const files=rows.slice(0,20);
  return {files,nextCursor:rows.length>20 ? files.at(-1)!.id : null};
}
