import { describe,expect,it } from '@jest/globals';
import { repairOroGuidance } from '../scripts/lib/oroSupportGuidance.js';
import type { PlaybookGraph } from '../models/supportOrchestration/schema.js';
describe('Oro owner guidance migration',()=>{
 it('changes knowledge instructions, not routing, consent fields or source graph',()=>{
  const graph:PlaybookGraph={entryNodeId:'start',nodes:[{id:'start',type:'trigger',data:{}},
   {id:'answer',type:'capability',data:{capabilityName:'knowledge.answer',instruction:'Answer verified facts.'}}],edges:[{source:'start',target:'answer'}],fields:[]};
  const before=JSON.stringify(graph);
  const result=repairOroGuidance(graph,[{id:'demo',messages:[{id:'53i0diqe',role:'agent',content:'I promise 2 PM.'},{id:'user',role:'user',content:'My requirement'}]}]);
  expect(JSON.stringify(graph)).toBe(before);
  expect(result.graph.edges).toEqual(graph.edges);
  expect(result.graph.fields).toEqual(graph.fields);
  expect(result.graph.nodes[1].data?.instruction).toContain('Wait for affirmative acceptance');
  expect(result.training[0].messages?.[0].content).not.toContain('2 PM');
  expect(result.training[0].messages?.[1].content).toBe('My requirement');
 });
});
