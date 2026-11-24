// Isolated visual preview of the real changed components. Authentication and
// Next navigation are substituted; this does not verify the full app shell.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const viteRequire = createRequire(createRequire(require.resolve('vitest/package.json')).resolve('vite/package.json'));
const esbuild = viteRequire('esbuild');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.responsive-ui-preview');
fs.mkdirSync(out, { recursive: true });
const navigation = `
import { useSyncExternalStore } from 'react';
const listen = cb => { addEventListener('popstate', cb); return () => removeEventListener('popstate', cb); };
const snapshot = () => location.pathname + location.search;
export const usePathname = () => useSyncExternalStore(listen, snapshot).split('?')[0];
export const useSearchParams = () => new URLSearchParams(location.search);
export const useParams = () => ({ threadId: ['42'] });
const router = { push: url => { history.pushState({}, '', url); dispatchEvent(new Event('popstate')); }, replace: url => { history.replaceState({}, '', url); dispatchEvent(new Event('popstate')); }, back: () => history.back() };
export const useRouter = () => router;
`;
const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {usePathname} from 'next/navigation';
import Proposals from './src/app/dashboard/(main)/proposals/page';
import LeadNew from './src/app/dashboard/(main)/leads/new/page';
import NewProposal from './src/app/dashboard/(main)/proposals/new/page';
import CampaignChatHeader from './src/components/CampaignChatHeader';
import {Tabs, TabsContent} from './src/components/ui/tabs';
import {ContactHistoryTabs, CONTACT_HISTORY_SECTIONS} from './src/components/crm/workspace/ContactHistoryTabs';
import {HistoryHeading, ContactHistoryToolbar} from './src/components/crm/workspace/HistoryControls';
import {EMPTY_HISTORY_FILTERS} from './src/lib/crm-workspace';
function CrmHistoryPreview() {
 const [tab,setTab]=useState('conversations'); const [filters,setFilters]=useState(EMPTY_HISTORY_FILTERS);
 const section=CONTACT_HISTORY_SECTIONS.find(section=>section.value===tab);
 const count=new URLSearchParams(location.search).has('stressCounts') ? 123456 : 0;
 return <div className="space-y-5 p-4 sm:p-6 lg:p-8"><h1 className="text-xl font-semibold">QA Browser Test 20261026</h1><div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_320px]"><section aria-label="Contact history" className="min-w-0"><Tabs value={tab} onValueChange={setTab}><ContactHistoryTabs count={()=>count}/><TabsContent value={tab} className="mt-5 space-y-4"><HistoryHeading title={section.title} description={section.description}/><ContactHistoryToolbar tab={tab} value={filters} onChange={setFilters}/><p className="text-sm text-muted-foreground">Synthetic history preview</p></TabsContent></Tabs></section><aside className="hidden rounded-xl border p-5 lg:block">Contact overview</aside></div></div>;
}
function Preview() {
 const pathname=usePathname(); const [view,setView]=useState('overview');
 return <main>{pathname.includes('/crm/contacts/') ? <CrmHistoryPreview/> : pathname.includes('/conversations/') ? <CampaignChatHeader campaignName=${JSON.stringify('QA TEST 2026-10-26 — Create a draft-only campaign plan for fictional Example Analytics with a long campaign title')} threadId={42} activeView={view} onViewChange={setView} onManageAgents={()=>{}} agents={['Coordinator','Research specialist','Content specialist','Outreach specialist','Performance specialist'].map((name,index)=>({id:String(index),name,initials:name[0],color:''}))} /> : pathname.includes('/leads/new') ? <LeadNew/> : pathname.endsWith('/proposals/new') ? <NewProposal/> : <Proposals/>}</main>;
}
createRoot(document.getElementById('root')).render(<Preview/>);
`;
(async () => {
 await esbuild.build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, absWorkingDir: root, outfile: path.join(out, 'preview.js'), bundle: true, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"', 'process.env.NEXT_PUBLIC_API_URL': '""' }, plugins: [{ name: 'preview-context', setup(build) {
  build.onResolve({filter: /^next\/navigation$/}, () => ({path: 'navigation', namespace: 'preview'}));
  build.onResolve({filter: /^@\/contexts\/AuthContext$/}, () => ({path: 'auth', namespace: 'preview'}));
  build.onResolve({filter: /^@\/contexts\/PreferencesContext$/}, () => ({path: 'preferences', namespace: 'preview'}));
  build.onLoad({filter: /.*/, namespace: 'preview'}, args => ({ contents: args.path === 'navigation' ? navigation : args.path === 'auth' ? 'export const useAuth = () => ({user:{id:4101},isAuthenticated:true});' : 'export const usePreferences = () => ({preferences:{currency:"USD"}});', loader: 'js', resolveDir: root }));
 } }] });
 execFileSync(process.execPath, [path.join(root, 'node_modules/tailwindcss/lib/cli.js'), '-i', 'src/app/globals.css', '-o', path.join(out, 'preview.css')], {cwd:root,stdio:'inherit'});
 const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/preview.css"><style>body{--font-sans:Arial,sans-serif}main{min-width:0}@media(min-width:1024px){main{margin-left:256px}}</style></head><body><div id="root"></div><script src="/preview.js"></script></body></html>';
 http.createServer((req,res) => { const asset = req.url === '/preview.js' ? 'preview.js' : req.url === '/preview.css' ? 'preview.css' : null; res.setHeader('Content-Type', asset?.endsWith('js') ? 'text/javascript' : asset ? 'text/css' : 'text/html'); res.end(asset ? fs.readFileSync(path.join(out,asset)) : html); }).listen(3101,'127.0.0.1',()=>console.log('Isolated component preview http://127.0.0.1:3101'));
})();
