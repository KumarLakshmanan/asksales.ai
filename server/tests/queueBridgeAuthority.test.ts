import {beforeEach,describe,expect,it,jest} from '@jest/globals';
import type {ToolContext} from '../mastra/tools/toolRegistry.js';
const dispatch=jest.fn<(...args:unknown[])=>Promise<unknown>>();
const waitForJobResult=jest.fn<(...args:unknown[])=>Promise<unknown>>();
let enabled=true;
jest.unstable_mockModule('../queues/JobDispatcher.js',()=>({jobDispatcher:{dispatch,isQueueEnabled:()=>enabled,getMetrics:jest.fn()}}));
jest.unstable_mockModule('../queues/index.js',()=>({queueRegistry:{waitForJobResult}}));
const {dispatchAndWait}=await import('../mastra/tools/queueBridge.js');
const context={userId:9,threadId:91} as ToolContext;
describe('queued tool authority and uncertain dispatch',()=>{
 beforeEach(()=>{enabled=true;dispatch.mockReset();waitForJobResult.mockReset();});
 it.each([[403,'ORGANIZATION_FORBIDDEN'],[403,'JOB_ACTOR_MISMATCH'],[409,'JOB_ORIGIN_REQUIRED'],[403,'BUSINESS_APPROVAL_REQUIRED'],[402,'SUBSCRIPTION_REQUIRED']] as const)('preserves %s %s without a direct effect',async(status,code)=>{
  const failure=Object.assign(new Error('Synthetic authority rejection'),{status,code});dispatch.mockRejectedValue(failure);
  const direct=jest.fn(async()=>({success:true,toolName:'generate_image'}));
  await expect(dispatchAndWait('generate_image',{},context,direct)).rejects.toBe(failure);
  expect(direct).not.toHaveBeenCalled();expect(waitForJobResult).not.toHaveBeenCalled();
 });
 it('does not execute directly when enqueue acknowledgement is uncertain',async()=>{
  const accepted:string[]=[];dispatch.mockImplementation(async()=>{accepted.push('accepted-before-lost-ack');throw new Error('ECONNRESET after queue insertion');});
  const direct=jest.fn(async()=>({success:true,toolName:'generate_image'}));
  await expect(dispatchAndWait('generate_image',{},context,direct)).rejects.toThrow('ECONNRESET');expect(accepted).toHaveLength(1);expect(direct).not.toHaveBeenCalled();
 });
 it('does not convert a definitive queue transport rejection to ungoverned direct execution',async()=>{
  dispatch.mockRejectedValue(new Error('Redis unavailable'));const direct=jest.fn(async()=>({success:true,toolName:'generate_video'}));
  await expect(dispatchAndWait('generate_video',{},context,direct)).rejects.toThrow('Redis unavailable');expect(direct).not.toHaveBeenCalled();
 });
 it('returns acknowledged worker rejection without duplicate effects',async()=>{
  dispatch.mockResolvedValue({queue:'fixture',jobId:'1',correlationId:'fixture'});waitForJobResult.mockRejectedValue(new Error('Worker authority rejected'));
  const direct=jest.fn(async()=>({success:true,toolName:'generate_image'}));
  expect(await dispatchAndWait('generate_image',{},context,direct)).toMatchObject({success:false,error:'Worker authority rejected'});expect(direct).not.toHaveBeenCalled();
 });
 it('returns the acknowledged queued result',async()=>{
  dispatch.mockResolvedValue({queue:'fixture',jobId:'1',correlationId:'fixture'});waitForJobResult.mockResolvedValue({synthetic:true});
  const direct=jest.fn(async()=>({success:true,toolName:'generate_image'}));
  expect(await dispatchAndWait('generate_image',{},context,direct)).toMatchObject({success:true,output:{synthetic:true}});expect(direct).not.toHaveBeenCalled();
 });
 it.each([['generate_image',false],['generate_icp',true]] as const)('retains deliberate direct mode %s/%s',async(tool,isEnabled)=>{
  enabled=isEnabled;const direct=jest.fn(async()=>({success:true,toolName:tool}));
  expect(await dispatchAndWait(tool,{},context,direct)).toMatchObject({success:true});expect(direct).toHaveBeenCalledTimes(1);expect(dispatch).not.toHaveBeenCalled();
 });
});
