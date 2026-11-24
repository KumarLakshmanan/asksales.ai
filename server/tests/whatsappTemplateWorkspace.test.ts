import { describe, it, expect } from '@jest/globals';
import { templateActivity, templateSnapshot, existingApprovedSnapshot, parseTemplateListQuery, clientTemplateRevisionMatches, templateMediaReferences } from '../utils/whatsappTemplateWorkspace.js';

describe('WhatsApp workspace safety contracts', () => {
  it('bounds history to the newest 50 records and captures content separately from provider state', () => {
    const activityHistory=Array.from({length:60},(_,index)=>({action:'edited',at:String(index)}));
    const history=templateActivity({activityHistory},'edited',{name:'message',body:'Edited'},'DRAFT');
    expect(history).toHaveLength(50); expect(history[0].at).toBe('11');
    expect(history.at(-1)).toMatchObject({action:'edited',status:'DRAFT',snapshot:{body:'Edited'}});
    expect(templateSnapshot({name:'message',body:'Edited',metaStatus:'APPROVED'})).not.toHaveProperty('metaStatus');
  });
  it('never labels an unsent local revision as the approved snapshot', () => {
    expect(existingApprovedSnapshot({body:'Local edit',metaStatus:'APPROVED',hasLocalChanges:true})).toBeNull();
    expect(existingApprovedSnapshot({body:'Approved',metaStatus:'APPROVED',hasLocalChanges:false})).toMatchObject({body:'Approved'});
    expect(existingApprovedSnapshot({body:'Edited',approvedSnapshot:{body:'Prior'}})).toEqual({body:'Prior'});
  });
  it('rejects invalid or unbounded pagination and sorting', () => {
    for (const query of [{page:'-1'},{pageSize:'101'},{sort:'sql'},{status:'invented'},{search:['a','b']},{language:'../../'},{search:'a'.repeat(256)}]) expect(parseTemplateListQuery(query).error).toBeTruthy();
    expect(parseTemplateListQuery({page:'2',pageSize:'24',sort:'name_desc',category:'ALL',language:'all'}).data).toMatchObject({page:2,pageSize:24,sort:'name_desc',category:'',language:''});
  });
  it('accepts exact microsecond revisions and older ISO clients while rejecting stale ones', () => {
    const template={revision:'2026-10-03 00:00:00.123456',updatedAt:new Date('2026-10-03T00:00:00.123Z')};
    expect(clientTemplateRevisionMatches(template.revision,template)).toBe(true);
    expect(clientTemplateRevisionMatches(template.updatedAt.toISOString(),template)).toBe(true);
    expect(clientTemplateRevisionMatches('2026-10-03T00:00:00.122Z',template)).toBe(false);
    expect(clientTemplateRevisionMatches(null,template)).toBe(true);
  });
});


it('retains and deduplicates media referenced by historical or approved revisions', () => {
  expect(templateMediaReferences({headerMediaUrl:'/uploads/new.png',approvedSnapshot:{headerMediaUrl:'/uploads/approved.png'},activityHistory:[{snapshot:{headerMediaUrl:'/uploads/old.png'}},{snapshot:{headerMediaUrl:'/uploads/new.png'}}]}))
    .toEqual(['/uploads/new.png','/uploads/approved.png','/uploads/old.png']);
});
