/** Account-only, optimistic-locked publication; active historical runs are not reset. */
import { sql } from 'drizzle-orm';
import { db,pgPool } from '../models/db.js';
import { recordSupportAdminAudit } from '../services/agents/orchestration/SupportAdminAuditService.js';
import { ORO_UNCERTAINTY_GUIDANCE,repairOroGuidance } from './lib/oroSupportGuidance.js';
import { sha256Hex as hash } from '../utils/sha256.js';
async function main(){
 const apply=process.argv.includes('--apply');
 await db.transaction(async (tx: any)=>{
  await tx.execute(sql`SELECT pg_advisory_xact_lock(21)`);
  const p=(await tx.execute(sql`SELECT p.*,v.graph,v.checksum FROM support_playbooks p
    JOIN support_playbook_versions v ON v.playbook_id=p.id AND v.version=p.active_version
    WHERE p.id=21 AND p.user_id=9 AND p.agent_type='hotel_sales' FOR UPDATE OF p`)).rows[0] as any;
  const a=(await tx.execute(sql`SELECT * FROM ai_agent_configs WHERE id=6 AND user_id=9 AND agent_type='hotel_sales' AND enabled=true FOR UPDATE`)).rows[0] as any;
  if(!p||!a)throw new Error('Oro active configuration was not found.');
  if(String(a.system_prompt).includes(ORO_UNCERTAINTY_GUIDANCE)){console.log('Guidance already applied.');return;}
  if(p.active_version!==15 || p.checksum!=='2aa146425c522afbd1811d4a9061458c2cb485fdf341413c723c4c6b6712f5b9'
    || JSON.stringify(p.graph)!==JSON.stringify(p.draft_graph)
    || hash(a.system_prompt)!=='4a68b16b6da3a9ae7e086e8b1ec1486089493c9c2ed64abe1678e9403adba49d'
    || hash(JSON.stringify(a.metadata.trainingConversations))!=='60d980d1f252e2ce1aa9c040a8e93374e72d8d348e54ac96631879917f0bdc4e')throw new Error('Configuration changed; review before applying.');
  const update=repairOroGuidance(p.graph,a.metadata.trainingConversations);
  const version=Number((await tx.execute(sql`SELECT COALESCE(MAX(version),0)::int+1 AS next FROM support_playbook_versions WHERE playbook_id=21`)).rows[0].next);
  const checksum=hash(JSON.stringify(update.graph));
  console.log(JSON.stringify({mode:apply?'apply':'dry-run',owner:9,playbook:21,previousVersion:15,newVersion:version,
    nodes:update.graph.nodes.length,knowledgeNodes:update.graph.nodes.filter(n=>n.data?.capabilityName==='knowledge.answer').length,
    historicalRunsReset:false,bookingAndConsentFieldsChanged:false}));
  if(!apply)return;
  await tx.execute(sql`INSERT INTO support_playbook_versions(playbook_id,version,graph,checksum,published_by,published_at)
    VALUES(21,${version},${JSON.stringify(update.graph)}::jsonb,${checksum},9,NOW())`);
  await tx.execute(sql`UPDATE support_playbooks SET draft_graph=${JSON.stringify(update.graph)}::jsonb,active_version=${version},updated_at=NOW() WHERE id=21 AND user_id=9`);
  const prompt=a.system_prompt+'\n\n'+ORO_UNCERTAINTY_GUIDANCE;
  const metadata={...a.metadata,trainingConversations:update.training};
  await tx.execute(sql`UPDATE ai_agent_configs SET system_prompt=${prompt},metadata=${JSON.stringify(metadata)}::jsonb,template_mode='customized',updated_at=NOW() WHERE id=6 AND user_id=9`);
  await recordSupportAdminAudit(tx,{userId:9,actorType:'owner',actorId:9,action:'playbook.oro_knowledge_guidance_repaired',entityType:'support_playbook',entityId:21,
    beforeState:{graph:p.graph,activeVersion:15,agentPrompt:a.system_prompt,agentMetadata:a.metadata},
    afterState:{graph:update.graph,activeVersion:version,agentPrompt:prompt,agentMetadata:metadata},
    metadata:{reason:'Owner requested confirmed KB answers and opt-in human support for uncertainty.',historicalRunsReset:false}});
 });
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}).finally(async()=>{await pgPool?.end();});
