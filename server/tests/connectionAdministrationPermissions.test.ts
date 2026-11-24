import {beforeEach,describe,expect,it,jest} from '@jest/globals';
import express, {type Request} from 'express';
import request from 'supertest';
import {readFileSync} from 'node:fs';
import {withBusinessScope,type BusinessRole} from '../tenancy/businessContext.js';
import {businessPermissions,requireBusinessManager} from '../middleware/businessPermissions.js';
const removeCredential=jest.fn<(ownerId:number,platform:string)=>Promise<void>>(async()=>undefined);
const removeDomain=jest.fn<(ownerId:number,domainId:string)=>Promise<void>>(async()=>undefined);
jest.unstable_mockModule('../models/channelCredentials/functions',()=>({ChannelCredentialModel:{delete:removeCredential}}));
jest.unstable_mockModule('../services/resendService',()=>({deleteDomainByResendId:removeDomain}));
jest.unstable_mockModule('../services/billing/entitlements.js',()=>({normalizeCapacityError:()=>undefined}));
jest.unstable_mockModule('../utils/channelCredentialSecrets.js',()=>({decryptChannelCredentialSession:jest.fn(),decryptChannelCredentialSecret:jest.fn(),encryptChannelCredentialSecret:jest.fn(),encryptChannelCredentialSession:jest.fn(),getChannelCredentialEncryptionKeyId:jest.fn()}));
jest.unstable_mockModule('../utils/msg91Credentials.js',()=>({inspectMSG91Credential:jest.fn(),readMSG91Settings:jest.fn(),validMSG91AuthKey:jest.fn()}));
jest.unstable_mockModule('../services/integrations/MSG91ProviderService.js',()=>({verifyMSG91Configuration:jest.fn()}));
const {disconnectMsg91}=await import('../controllers/msg91SettingsController.js');
const {deleteDomain}=await import('../controllers/resendController.js');
const mutations=[['post','/api/msg91-settings'],['post','/api/msg91-settings/test'],['delete','/api/msg91-settings'],['post','/api/resend/domains'],['patch','/api/resend/domains/fixture'],['post','/api/resend/domains/fixture/verify'],['post','/api/resend/domains/fixture/enable-receiving'],['delete','/api/resend/domains/fixture']] as const;
function app(role:BusinessRole,actor=role==='owner'?9:17,explicit=false){
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={id:actor} as Request['user'];withBusinessScope({userId:9,businessProfileId:91,actorUserId:role==='owner'?9:17,role},next);});
 app.use(explicit?requireBusinessManager:businessPermissions);
 app.delete('/api/msg91-settings',disconnectMsg91);app.delete('/api/resend/domains/:id',deleteDomain);
 app.use((_req,res)=>res.json({success:true}));return app;
}
describe('mounted connection administration capabilities',()=>{
 beforeEach(()=>{removeCredential.mockClear();removeDomain.mockClear();});
 it.each(mutations)('rejects member %s %s before any effect',async(method,path)=>{
  const res=await request(app('member'))[method](path).send({});expect(res.status).toBe(403);expect(removeCredential).not.toHaveBeenCalled();expect(removeDomain).not.toHaveBeenCalled();
 });
 it.each(['owner','billing_admin'] as const)('keeps %s disconnect bound to business owner',async(role)=>{
  expect((await request(app(role)).delete('/api/msg91-settings')).status).toBe(200);expect(removeCredential).toHaveBeenCalledWith(9,'msg91_sms');
  expect((await request(app(role)).delete('/api/resend/domains/fixture')).status).toBe(200);expect(removeDomain).toHaveBeenCalledWith(9,'fixture');
 });
 it('explicit route capability rejects a member without central classification',async()=>{
  expect((await request(app('member',17,true)).delete('/api/msg91-settings')).status).toBe(403);expect(removeCredential).not.toHaveBeenCalled();
 });
 it('rejects authority for a different actor',async()=>{
  expect((await request(app('billing_admin',18)).delete('/api/msg91-settings')).status).toBe(403);expect(removeCredential).not.toHaveBeenCalled();
 });
 it.each(['/api/msg91-settings','/api/resend/domains'])('preserves existing member readiness reads %s',async path=>{expect((await request(app('member')).get(path)).status).toBe(200);});
 it('preserves operational SMS route permissions',async()=>{expect((await request(app('member')).post('/api/whatsapp/send/text').send({})).status).toBe(200);});
 it('declares manager authority on every concrete mutation in the production registry',()=>{
  const source=readFileSync(new URL('../routes.ts',import.meta.url),'utf8');
  for(const [method,path] of mutations){const canonical=path.replace('fixture',':id');const declaration=source.split('\n').find(line=>line.includes(`app.${method}("${canonical}"`));expect(declaration).toContain('authenticateToken, requireBusinessManager,');}
 });
});
