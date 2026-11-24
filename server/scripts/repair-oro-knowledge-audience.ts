/** Oro Circle scope repair. Dry-run by default; --apply uses the normal
 * versioned knowledge governance path. Never edits/deletes source content. */
import { sql } from 'drizzle-orm';
import { pgPool } from '../models/db.js';
import { withTenantKnowledgeTransaction } from '../services/knowledge/KnowledgeTenantTransaction.js';
import { knowledgeGovernanceService } from '../services/knowledge/KnowledgeGovernanceService.js';
import type { KnowledgePublicationMetadata } from '../services/knowledge/KnowledgePublicationMetadata.js';

const userId=9;
const targets=[
  {id:9,legacy:16,version:25,title:'Unhurried Execution and Tariff Plan'},
  {id:12,legacy:20,version:28,title:'ORO_Resort_Property_Sales_Information_Updated'},
  // Documents 13/14 are privacy-classified personal and already excluded
  // from retrieval. They require privacy review, not a publication bypass.
  {id:20,legacy:37,version:36,title:'Maximum Discounts'},
];
async function main() {
  const apply=process.argv.includes('--apply');
  const plan=await withTenantKnowledgeTransaction(userId,async tx=>{
    const rows=[];
    for(const target of targets) {
      const result=await tx.execute(sql`SELECT d.*,v.status,v.authority,v.effective_at,v.expires_at,v.review_due_at,
        v.lexical_index_status,v.vector_index_status,v.diagnostics
        FROM knowledge_documents d JOIN knowledge_document_versions v ON v.id=d.current_published_version_id AND v.user_id=d.user_id
        WHERE d.user_id=${userId} AND d.id=${target.id} AND d.legacy_entry_id=${target.legacy}`);
      const row=result.rows[0] as Record<string,any> | undefined;
      if(!row || row.title!==target.title) throw new Error(`Owned document identity changed: ${target.id}`);
      if(row.audience==='internal' && row.access_scope==='staff_only') continue;
      if(Number(row.current_published_version_id)!==target.version || row.status!=='published'
        || row.lexical_index_status!=='completed' || row.vector_index_status!=='completed') throw new Error(`Publication changed: ${target.id}`);
      const draft=await tx.execute(sql`SELECT id FROM knowledge_document_versions WHERE user_id=${userId}
        AND document_id=${target.id} AND status='ready_for_review'`);
      if(draft.rows.length) throw new Error(`Existing draft must be reviewed first: ${target.id}`);
      if(row.diagnostics?.injectionFlags?.length || row.diagnostics?.conflictVersionIds?.length) throw new Error(`Unresolved governance flags: ${target.id}`);
      const metadata:KnowledgePublicationMetadata={title:row.title,sourceUrl:row.source_url||null,
        businessProfileId:row.business_profile_id?Number(row.business_profile_id):null,
        audience:'internal',accessScope:'staff_only',usageScopes:['internal_assist'],allowedChannels:[],locale:row.locale||null};
      rows.push({target,row,metadata});
    }
    return rows;
  });
  console.log(JSON.stringify({mode:apply?'apply':'dry-run',userId,changes:plan.map(p=>({documentId:p.target.id,title:p.target.title,
    fromVersion:p.target.version,audience:'internal',accessScope:'staff_only',contentPreserved:true}))}));
  if(!apply)return;
  for(const {target,row,metadata} of plan) {
    // The governance methods independently take tenant locks and validate
    // ownership, privacy, scope and readiness. Abort rather than overwrite drafts.
    const draft=await knowledgeGovernanceService.createDraft({userId,legacyEntryId:target.legacy,versionId:target.version});
    await knowledgeGovernanceService.updateDraftScope({userId,legacyEntryId:target.legacy,versionId:draft.versionId,metadata});
    const result=await knowledgeGovernanceService.publish({userId,actorUserId:userId,legacyEntryId:target.legacy,
      versionId:draft.versionId,authority:row.authority,
      effectiveAt:row.effective_at?new Date(row.effective_at).toISOString():null,
      expiresAt:row.expires_at?new Date(row.expires_at).toISOString():null,
      reviewDueAt:row.review_due_at?new Date(row.review_due_at).toISOString():null,
      supersedesVersionId:target.version});
    console.log(JSON.stringify({oldVersion:target.version,...result,sourceContentChanged:false}));
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;})
  .finally(async()=>{await pgPool?.end();});
