import { describe, expect, it } from '@jest/globals';
import { parseJourneyDate } from '../services/agents/orchestration/JourneyDateParser.js';
import { correctJourneyFields, initializeJourneyState } from '../services/agents/orchestration/SupportJourneyRuntime.js';
import type { PlaybookGraph } from '../models/supportOrchestration/schema.js';
import { semanticIntent } from './helpers/supportSemanticFixture.js';

describe('Oro stay-date regressions', () => {
  it.each(['25sep', '25 sep', '25thSeptember'])('accepts a compact explicit date: %s', text => {
    expect(parseJourneyDate(text,'stay.checkOut',true,new Date('2026-09-23T12:00:00Z'))).toBe('2026-09-25');
  });
  it('does not swap labelled compact endpoints', () => {
    const now=new Date('2026-09-23T12:00:00Z');
    expect(parseJourneyDate('Check in 10oct checkout 11oct','stay.checkIn',false,now)).toBe('2026-10-10');
    expect(parseJourneyDate('Check in 10oct checkout 11oct','stay.checkOut',false,now)).toBe('2026-10-11');
  });
  it.each([
    '18 November 2026, and we will check out on 20 November 2026.',
    '18 November 2026; checkout 20 November 2026',
  ])('keeps a pending check-in answer separate from the later checkout clause: %s', text => {
    const now = new Date('2026-10-29T00:00:00Z');
    expect(parseJourneyDate(text,'stay.checkIn',true,now)).toBe('2026-11-18');
    expect(parseJourneyDate(text,'stay.checkOut',false,now)).toBe('2026-11-20');
    expect(parseJourneyDate(text,'stay.checkIn',false,now)).toBeUndefined();
  });
  it('does not turn a date before its own checkout label into an unlabeled check-in', () => {
    const now = new Date('2026-10-29T00:00:00Z');
    expect(parseJourneyDate('20 November 2026 is checkout','stay.checkIn',true,now)).toBeUndefined();
    expect(parseJourneyDate('18 November or 19 November, checkout 20 November','stay.checkIn',true,now)).toBeUndefined();
  });
  it('updates both dotted-date corrections and invalidates prior confirmation/evidence', () => {
    const graph: PlaybookGraph={schemaVersion:2,entryNodeId:'start',nodes:[],edges:[],fields:[
      {key:'stay.checkIn',type:'date',pii:'none',prompt:'Check-in?',required:true,validation:{entityKeys:['checkIn']}},
      {key:'stay.checkOut',type:'date',pii:'none',prompt:'Check-out?',required:true,validation:{entityKeys:['checkOut']}},
      {key:'stay.confirmed',type:'boolean',pii:'none',prompt:'Confirm?',required:true},
    ]};
    const state=initializeJourneyState(graph);
    state.fields['stay.checkIn']={value:'2026-10-11',status:'collected',source:'customer'};
    state.fields['stay.checkOut']={value:'2026-10-12',status:'collected',source:'customer'};
    state.fields['stay.confirmed']={value:true,status:'collected',source:'customer'};
    state.capabilityStatus={'availability.check':'success'};
    const result=correctJourneyFields(graph,state,{inboundText:'Check in 10.10.26 Check out 11.10.26',
      semanticRequest:semanticIntent('correction','stay'),entities:{checkIn:'2026-10-10',checkOut:'2026-10-11'}});
    expect(result.changedFields).toEqual(['stay.checkIn','stay.checkOut']);
    expect(result.state.fields['stay.checkIn'].value).toBe('2026-10-10');
    expect(result.state.fields['stay.checkOut'].value).toBe('2026-10-11');
    expect(result.state.fields['stay.confirmed'].status).toBe('missing');
    expect(result.state.capabilityStatus).toBeUndefined();
  });
});
