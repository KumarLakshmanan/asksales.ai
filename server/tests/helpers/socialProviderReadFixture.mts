// Uses the actual frontend API client and social read helper over loopback HTTP.
// Only computed dynamic import keeps browser-only types out of the server checker.
const endpoint=new URL(process.argv[2]);
if(endpoint.hostname!=='127.0.0.1'||!['/api/social-analytics/content/99/comments','/api/social-envelope-gateway-fixture'].includes(endpoint.pathname))throw new Error('Local Social envelope fixture only');
const {socialInsightsGet}=await import(new URL('../../../client/src/lib/socialInsightsApi.ts',import.meta.url).href);
try{const result=await socialInsightsGet(endpoint.href);process.stdout.write(JSON.stringify({outcome:'resolved',result})+'\n');}
catch(error){const result=error as {status?:number;data?:{code?:string}};process.stdout.write(JSON.stringify({outcome:'rejected',status:result.status,code:result.data?.code})+'\n');}
