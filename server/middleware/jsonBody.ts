import express,{type Request,type RequestHandler} from 'express';

/** A reviewed bulk campaign repeats the approved content for each recipient.
 * Keep the ordinary API/webhook limit, with a bounded larger canonical bulk
 * endpoint matching the reverse proxy's existing 50 MB limit. */
export function createJsonBodyParser(options:{standardLimit?:number|string;bulkLimit?:number|string}={}):RequestHandler {
  const verify=(req:import('node:http').IncomingMessage,_res:import('node:http').ServerResponse,buf:Buffer)=>{
    (req as Request & {rawBody?:Buffer}).rawBody=buf;
  };
  const standard=express.json({limit:options.standardLimit ?? '10mb',verify});
  const bulk=express.json({limit:options.bulkLimit ?? '50mb',verify});
  return (req,res,next)=>(req.method==='POST' && req.path==='/api/outreach-conversations/bulk' ? bulk : standard)(req,res,next);
}
