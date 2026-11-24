// Runs the actual dashboard providers, auth/layout guards, conversation page,
// chat composer and creator components. Only Next routing/SSR is substituted.
// creator-action-boundary.spec.ts intercepts every application API with fixtures.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const viteRequire = createRequire(createRequire(require.resolve('vitest/package.json')).resolve('vite/package.json'));
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.creator-action-shell-qa');
fs.mkdirSync(output, { recursive: true });
const navigation = `
import {useMemo,useSyncExternalStore} from 'react';
const subscribe=cb=>{addEventListener('popstate',cb);return()=>removeEventListener('popstate',cb)};
const snapshot=()=>location.pathname+location.search;
const navigate=(url,replace=false)=>{history[replace?'replaceState':'pushState']({},'',url);dispatchEvent(new Event('popstate'))};
const router={push:url=>navigate(url),replace:url=>navigate(url,true),back:()=>history.back(),forward:()=>history.forward(),refresh:()=>dispatchEvent(new Event('popstate')),prefetch:()=>Promise.resolve()};
export const useRouter=()=>router;
export const usePathname=()=>useSyncExternalStore(subscribe,snapshot).split('?')[0];
export const useSearchParams=()=>{const value=useSyncExternalStore(subscribe,snapshot);return useMemo(()=>new URLSearchParams(value.split('?')[1]||''),[value])};
export const useParams=()=>{const value=usePathname();return useMemo(()=>({threadId:value.match(/conversations\\/(\\d+)/)?.slice(1)||[]}),[value])};
`;
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {usePathname} from 'next/navigation';
import {Providers} from './src/components/Providers';
import DashboardGuard from './src/app/dashboard/layout';
import Dashboard from './src/app/dashboard/(main)/layout';
import ConversationsPage from './src/app/dashboard/(main)/conversations/[[...threadId]]/page';
import AdCreator from './src/components/content-studio/creators/AdCreator';
function App(){const pathname=usePathname();return <Providers><DashboardGuard><Dashboard>{pathname.includes('/conversations/')?<ConversationsPage/>:<AdCreator/>}</Dashboard></DashboardGuard></Providers>}
createRoot(document.getElementById('root')).render(<App/>);
`;
(async () => {
  await viteRequire('esbuild').build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, absWorkingDir: root, outfile: path.join(output, 'shell.js'), bundle: true, platform: 'browser', jsx: 'automatic', banner: { js: 'var process={env:{NODE_ENV:"development"},browser:true};' }, define: { 'process.env.NODE_ENV': '"development"', 'process.env.NEXT_PUBLIC_API_URL': '""', 'process.env.NEXT_PUBLIC_WS_URL': '""' }, plugins: [{ name: 'next-routing-fixture', setup(build) {
    build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'routing-fixture' }));
    build.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'routing-fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'routing-fixture' }, args => ({ contents: args.path === 'navigation' ? navigation : "import React from 'react';export default React.forwardRef(function Link({href,prefetch,replace,scroll,...props},ref){return <a ref={ref} href={typeof href==='string'?href:href?.pathname} {...props}/>});", loader: 'jsx', resolveDir: root }));
  } }] });
  execFileSync(process.execPath, [path.join(root, 'node_modules/tailwindcss/lib/cli.js'), '-i', 'src/app/globals.css', '-o', path.join(output, 'shell.css')], { cwd: root, stdio: 'inherit' });
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/shell.css"><style>body{--font-sans:Arial,sans-serif}</style></head><body><div id="root"></div><script src="/shell.js"></script></body></html>';
  http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1:3117').pathname;
    const asset = pathname === '/shell.js' ? 'shell.js' : pathname === '/shell.css' ? 'shell.css' : null;
    if (asset) { res.setHeader('Content-Type', asset.endsWith('.js') ? 'text/javascript' : 'text/css'); return res.end(fs.readFileSync(path.join(output, asset))); }
    const publicRoot = path.join(root, 'public');
    const publicFile = path.resolve(publicRoot, '.' + pathname);
    if (publicFile.startsWith(publicRoot + path.sep) && fs.existsSync(publicFile) && fs.statSync(publicFile).isFile()) { if (publicFile.endsWith('.svg')) res.setHeader('Content-Type', 'image/svg+xml'); return res.end(fs.readFileSync(publicFile)); }
    res.setHeader('Content-Type', 'text/html'); res.end(html);
  }).listen(3117, '127.0.0.1', () => console.log('Actual component-tree shell preview: http://127.0.0.1:3117'));
})();
