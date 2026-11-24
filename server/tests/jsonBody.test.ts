import {describe,expect,it} from '@jest/globals';
import express,{type ErrorRequestHandler,type Request} from 'express';
import type {Server} from 'node:http';
import {createJsonBodyParser} from '../middleware/jsonBody.js';

async function withServer(options:Parameters<typeof createJsonBodyParser>[0],work:(url:string)=>Promise<void>) {
  const app=express();app.use(createJsonBodyParser(options));
  app.use((req,res)=>res.json({count:req.body?.messages?.length,first:req.body?.messages?.[0],last:req.body?.messages?.at(-1),
    confirmation:req.body?.confirmation,idempotencyKey:req.body?.idempotencyKey,rawBytes:(req as Request & {rawBody?:Buffer}).rawBody?.length,
    ...(!req.body?.messages ? {raw:(req as Request & {rawBody?:Buffer}).rawBody?.toString('utf8')} : {})}));
  const errors:ErrorRequestHandler=(error,_req,res,_next)=>{res.status(error.status || 500).json({error:error.type});};app.use(errors);
  const server=await new Promise<Server>(resolve=>{const active=app.listen(0,'127.0.0.1',()=>resolve(active));});
  try {const address=server.address();if(!address || typeof address==='string')throw new Error('Local fixture address unavailable');await work(`http://127.0.0.1:${address.port}`);}
  finally {await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve()));}
}
const post=(url:string,body:string,method='POST')=>fetch(url,{method,headers:{'content-type':'application/json'},body});

describe('bounded JSON admission for large reviewed outreach',()=>{
  it('accepts the complete 30,202-recipient approved-template payload without changing it',async()=>{
    const message="*This Diwali, celebrate under the Nandi Hills sky.*\n\nTrade the city noise for lantern-lit evenings, slow mornings and the festival of lights the way it's meant to feel.\n\n🪔 *Diwali Retreat at ORO Resorts*\n2-night indulgent stay\nStarting from *₹40,000*\n\nLimited rooms for the festive weekend.\n\n📞 Reserve now: +91 79964 19996\n✉️ reservations@orocircle.com";
    const messages=Array.from({length:30202},(_,index)=>({leadId:index+1,expectedRecipient:`919${String(index).padStart(9,'0')}`,message,followUps:[],
      templateName:'diwali2026',templateLanguage:'en',templateComponents:[{type:'header',parameters:[{type:'image',image:{id:'isolated-fixture-media'}}]}]}));
    const confirmation={confirmed:true,channel:'whatsapp',recipientCount:messages.length};
    const body=JSON.stringify({channel:'whatsapp',messages,confirmation,idempotencyKey:'isolated-campaign-request',whatsappOptInConfirmed:true});
    expect(Buffer.byteLength(body)).toBeGreaterThan(10*1024*1024);expect(Buffer.byteLength(body)).toBeLessThan(50*1024*1024);
    await withServer({},async url=>{
      const response=await post(url+'/api/outreach-conversations/bulk',body);expect(response.status).toBe(200);
      expect(await response.json()).toEqual({count:30202,first:messages[0],last:messages.at(-1),confirmation,
        idempotencyKey:'isolated-campaign-request',rawBytes:Buffer.byteLength(body)});
    });
  },30000);
  it('keeps the ordinary limit for other paths and methods',async()=>{
    const body=JSON.stringify({text:'x'.repeat(90)});
    await withServer({standardLimit:80,bulkLimit:160},async url=>{
      expect((await post(url+'/api/outreach-conversations/bulk',body)).status).toBe(200);
      for(const [path,method] of [['/api/settings','POST'],['/api/outreach-conversations/bulk-extra','POST'],['/api/outreach-conversations/bulk','PUT']])
        expect((await post(url+path,body,method)).status).toBe(413);
      expect((await post(url+'/api/outreach-conversations/bulk',JSON.stringify({text:'x'.repeat(200)}))).status).toBe(413);
    });
  });
  it('retains the exact raw webhook bytes for signature verification',async()=>{
    const body='{ "object": "whatsapp_business_account", "text": "🪔" }';
    await withServer({},async url=>{
      const response=await post(url+'/api/meta/webhook',body);expect(response.status).toBe(200);
      expect(await response.json()).toEqual({rawBytes:Buffer.byteLength(body),raw:body});
    });
  });
});
