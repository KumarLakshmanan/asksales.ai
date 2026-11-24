import { describe, expect, it } from '@jest/globals';
import { emptyAssistantDraft } from '../../shared/outreachAssistants.js';
import { withAssistantContext, type ResolvedAssistant } from '../services/assistants/AssistantContext.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { usageMetadata } from '../services/insights/UsageContext.js';

const scope={userId:1,businessProfileId:9,actorUserId:1,role:'owner' as const};
const context:ResolvedAssistant={configuration:emptyAssistantDraft(),preview:false,provenance:{assistantId:'c1a11111-1111-4111-8111-111111111111',businessProfileId:9,revision:2,bindingId:3,bindingVersion:4,accountId:'verified-account',channel:'whatsapp',surface:'private'}};
describe('server-resolved assistant usage attribution',()=>{
  it('discards supplied reserved provenance when no assistant context exists',()=>{
    expect(withBusinessScope(scope,()=>usageMetadata({_assistant:{assistantId:'spoof'},purpose:'reply'}))).toEqual({purpose:'reply'});
  });
  it('uses the frozen matching context across async boundaries and records preview explicitly',async()=>{
    const result=await withBusinessScope(scope,()=>withAssistantContext(context,async()=>{await Promise.resolve();return usageMetadata({_assistant:{assistantId:'spoof'}});}));
    expect(result._assistant).toEqual({...context.provenance,preview:false});
    expect(withBusinessScope(scope,()=>withAssistantContext({...context,preview:true},()=>usageMetadata()))._assistant).toEqual({...context.provenance,preview:true});
  });
  it('never carries attribution into a different business profile',()=>{
    expect(withBusinessScope({...scope,businessProfileId:10},()=>withAssistantContext(context,()=>usageMetadata({_assistant:{assistantId:'spoof'}})))).not.toHaveProperty('_assistant');
  });
});
