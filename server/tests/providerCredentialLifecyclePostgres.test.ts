/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll,beforeAll,beforeEach,describe,expect,it,jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle,type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { randomBytes } from 'node:crypto';
import { channelCredentialsTable } from '../models/channelCredentials/schema.js';
import { emailSendersTable } from '../models/emailSenders/schema.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { encryptChannelCredentialSecret, decryptChannelCredentialSecret } from '../utils/channelCredentialSecrets.js';
const url=process.env.PROVIDER_FIXES_QA_DATABASE_URL;
const suite=url ? describe : describe.skip;
let database: NodePgDatabase;
jest.unstable_mockModule('../models/db.js',()=>({db:new Proxy({}, {get:(_target,key)=>{
  const value=database[key as keyof NodePgDatabase];return typeof value==='function' ? value.bind(database) : value;
}})}));
jest.unstable_mockModule('../models/metaPageConnections/functions.js',()=>({disconnectAdsForUser:jest.fn()}));
jest.unstable_mockModule('../utils/logger.js',()=>({logger:{info:jest.fn(),warn:jest.fn(),error:jest.fn()}}));
const {refreshChannelCredential}=await import('../services/ChannelCredentialRefreshService.js');
const {disconnectGmailAccounts}=await import('../services/GmailDisconnectService.js');
const {disconnectIntegration}=await import('../controllers/integrationDisconnectController.js');
const binding={userId:9,credentialId:31,platform:'gmail_api',accountIdentifier:'owner@example.test'};
suite('provider credential lifecycle in disposable PostgreSQL',()=>{
  let admin:Pool,pool:Pool,schema:string;
  beforeAll(async()=>{
    if(!url?.includes('host=/tmp/gmail-oauth-followup-provider-audit/postgres-socket')) throw new Error('Explicit disposable audit socket required');
    schema=`provider_fixes_${randomBytes(8).toString('hex')}`;
    admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString:url,max:4,options:`-c search_path=${schema},pg_catalog`});database=drizzle(pool);
    for(const table of [channelCredentialsTable,emailSendersTable]) {
      const config=getTableConfig(table);
      const columns=config.columns.map(column=>`"${column.name}" ${column.getSQLType()}${column.primary?' PRIMARY KEY':''}`);
      await pool.query(`CREATE TABLE ${config.name}(${columns.join(',')})`);
    }
    await pool.query('CREATE TABLE api_credentials(user_id integer,service_name text,is_active boolean,updated_at timestamptz)');
  });
  afterAll(async()=>{await pool?.end();if(schema&&admin) await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin?.end();});
  beforeEach(async()=>{
    await pool.query('TRUNCATE channel_credentials,email_senders,api_credentials');
    await pool.query(`INSERT INTO channel_credentials(id,user_id,platform,credential_type,is_active,account_identifier,access_token,refresh_token,token_expiry,session_data) VALUES
      (31,9,'gmail_api','oauth',true,'owner@example.test',$1,$2,NOW()-INTERVAL '1 hour','{"watchExpiration":"preserve","lastHistoryId":"100"}'),
      (32,9,'gmail_api','oauth',true,'other@example.test',$1,$3,NOW()-INTERVAL '1 hour','{}'),
      (33,10,'gmail_api','oauth',true,'foreign@example.test',$1,$2,NOW()-INTERVAL '1 hour','{}');
      `,[encryptChannelCredentialSecret('old-access'),encryptChannelCredentialSecret('old-refresh'),encryptChannelCredentialSecret('other-refresh')]);
    await pool.query(`INSERT INTO email_senders(id,user_id,type,credential_id) VALUES(1,9,'gmail',31),(2,9,'gmail',32),(3,10,'gmail',33),(4,9,'resend',NULL)`);
  });
  const state=async(id=31)=>(await pool.query('SELECT * FROM channel_credentials WHERE id=$1',[id])).rows[0];
  const tokens=()=>({accessToken:'new-access',refreshToken:'new-refresh',expiresAt:new Date(Date.now()+3600_000)});
  it('serializes separate transactions and refreshes once, preserving unrelated mailboxes and cursor',async()=>{
    const refresh=jest.fn<any>().mockImplementation(async()=>tokens());
    const results=await Promise.all([refreshChannelCredential(binding,refresh),refreshChannelCredential(binding,refresh)]);
    expect(results.every(result=>result.credential)).toBe(true);expect(refresh).toHaveBeenCalledTimes(1);
    expect(decryptChannelCredentialSecret((await state()).access_token)).toBe('new-access');
    expect((await state()).session_data).toEqual({watchExpiration:'preserve',lastHistoryId:'100'});
    expect(decryptChannelCredentialSecret((await state(32)).access_token)).toBe('old-access');
  });
  it.each(['success','invalid_grant'])('a reconnect waits for an in-flight %s and remains active with fresh tokens',async outcome=>{
    let enter!:()=>void,release!:()=>void;
    const entered=new Promise<void>(resolve=>{enter=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
    const pending=refreshChannelCredential(binding,async()=>{enter();await gate;if(outcome==='invalid_grant') throw {response:{data:{error:'invalid_grant'}}};return tokens();});
    await entered;
    const reconnect=pool.query("UPDATE channel_credentials SET is_active=true,access_token=$1,refresh_token=$2,token_expiry=NOW()+INTERVAL '2 hours',readiness_error_code=NULL WHERE id=31",[encryptChannelCredentialSecret('reconnect-access'),encryptChannelCredentialSecret('reconnect-refresh')]);
    release();await pending;await reconnect;
    const row=await state();expect(row.is_active).toBe(true);expect(decryptChannelCredentialSecret(row.access_token)).toBe('reconnect-access');expect(decryptChannelCredentialSecret(row.refresh_token)).toBe('reconnect-refresh');
  });
  it('rereads the winning reconnect under the lock instead of refreshing an old snapshot',async()=>{
    await pool.query("UPDATE channel_credentials SET access_token=$1,token_expiry=NOW()+INTERVAL '2 hours' WHERE id=31",[encryptChannelCredentialSecret('reconnect-access')]);
    const refresh=jest.fn<any>();expect((await refreshChannelCredential(binding,refresh)).credential).toBeTruthy();expect(refresh).not.toHaveBeenCalled();
  });
  it('deactivates only the exact revoked grant and leaves a transient failure connected',async()=>{
    await expect(refreshChannelCredential(binding,async()=>{throw new Error('fixture timeout');})).rejects.toThrow('fixture timeout');expect((await state()).is_active).toBe(true);
    expect((await refreshChannelCredential(binding,async()=>{throw {response:{data:{error:'invalid_grant'}}};})).reconnectRequired).toBe(true);
    expect((await state()).is_active).toBe(false);expect((await state()).readiness_error_code).toBe('TOKEN_REFRESH_REJECTED');expect((await state(32)).is_active).toBe(true);
  });
  it('rejects wrong owner, mailbox and inactive bindings before provider access',async()=>{
    const refresh=jest.fn<any>();
    for(const changed of [{userId:10},{accountIdentifier:'foreign@example.test'}]) expect((await refreshChannelCredential({...binding,...changed},refresh)).credential).toBeNull();
    await pool.query('UPDATE channel_credentials SET is_active=false WHERE id=31');expect((await refreshChannelCredential(binding,refresh)).credential).toBeNull();expect(refresh).not.toHaveBeenCalled();
  });
  it('rejects malformed refresh receipts without changing tokens',async()=>{
    await expect(refreshChannelCredential(binding,async()=>({...tokens(),accessToken:''}))).rejects.toThrow('incomplete');expect(decryptChannelCredentialSecret((await state()).access_token)).toBe('old-access');
  });
  it('disconnects all local Gmail accounts, attempts each grant and reports partial remote failure',async()=>{
    const fetch=jest.fn<any>().mockResolvedValueOnce(new Response(null,{status:500})).mockResolvedValueOnce(new Response(null,{status:200}));globalThis.fetch=fetch;
    const result=await disconnectGmailAccounts(9);expect(result).toMatchObject({disconnectedAccounts:2,remoteRevocationComplete:false,revocationFailures:1,warning:expect.any(String)});expect(fetch).toHaveBeenCalledTimes(2);
    for(const id of [31,32]) {const row=await state(id);expect(row.is_active).toBe(false);expect(row.access_token).toBeNull();expect(row.refresh_token).toBeNull();}
    expect((await state(33)).is_active).toBe(true);expect((await pool.query('SELECT id FROM email_senders ORDER BY id')).rows).toEqual([{id:3},{id:4}]);
    expect(await disconnectGmailAccounts(9)).toMatchObject({disconnectedAccounts:0,remoteRevocationComplete:true});
  });
  it.each(['gmail','twitter','linkedin','google-ads','sms','email'])('unified %s disconnect works with real typed SQL and is idempotent',async platform=>{
    await pool.query("INSERT INTO channel_credentials(id,user_id,platform,is_active) VALUES(41,9,'twitter_api',true),(42,9,'linkedin_api',true),(43,9,'msg91_sms',true); INSERT INTO api_credentials VALUES(9,'google_ads',true,NOW()),(9,'resend',true,NOW()),(9,'gmail_smtp',true,NOW())");
    for(let i=0;i<2;i++) {
      const res:any={json:jest.fn(),status:jest.fn()};res.status.mockReturnValue(res);
      await withBusinessScope({userId:9,businessProfileId:11},()=>disconnectIntegration({user:{id:9},params:{platform}} as any,res));
      expect(res.status).not.toHaveBeenCalled();expect(res.json).toHaveBeenCalledWith(expect.objectContaining({success:true,remoteRevocationAttempted:false}));
      if(i===0) { const body=res.json.mock.calls[0][0];expect(body.channelRowsTouched+body.apiRowsTouched).toBeGreaterThan(0); }
      if(i===1) expect(res.json.mock.calls[0][0]).toMatchObject({channelRowsTouched:0,apiRowsTouched:0});
    }
    expect((await state(33)).is_active).toBe(true);
  });
});
