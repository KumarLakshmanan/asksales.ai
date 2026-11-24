// Opt-in loopback-only React/HTTP fixture (Node 24). No production providers.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const client = fileURLToPath(new URL('../../../client/', import.meta.url));
const requireClient = createRequire(path.join(client, 'package.json'));
const requireVitest = createRequire(requireClient.resolve('vitest'));
const { createServer } = await import(requireVitest.resolve('vite'));
const root = await mkdtemp(path.join(tmpdir(), 'admin-usage-browser-'));
await symlink(path.join(client, 'node_modules'), path.join(root, 'node_modules'), 'dir');
await writeFile(path.join(root, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>');
await writeFile(path.join(root, 'main.tsx'), "import React from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import Page from '@/app/admin/dashboard/users/[id]/usage/page';import Wallets from '@/components/admin/OrganizationCredits';const view=new URLSearchParams(location.search).get('view');createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>{view==='wallets'?<Wallets/>:<Page/>}</QueryClientProvider>);");
await writeFile(path.join(root, 'next.tsx'), "import React from 'react';export const useParams=()=>({id:'11'});export default function Link({href,children,...rest}){return <a href={href} {...rest}>{children}</a>}");
await writeFile(path.join(root, 'toast.ts'), 'const toast=()=>{};export const useToast=()=>({toast});');
await writeFile(path.join(root, 'plan.tsx'), 'export default function Plan(){return null}');
const server = await createServer({ configFile: false, envFile: false, root,
  esbuild: { jsx: 'automatic' }, define: { 'process.env.NEXT_PUBLIC_API_URL': '""' },
  resolve: { dedupe: ['react', 'react-dom'], alias: [
    { find: 'next/link', replacement: path.join(root, 'next.tsx') },
    { find: 'next/navigation', replacement: path.join(root, 'next.tsx') },
    { find: '@/hooks/use-toast', replacement: path.join(root, 'toast.ts') },
    { find: '@/components/admin/AdminPlanAssignment', replacement: path.join(root, 'plan.tsx') },
    { find: '@', replacement: path.join(client, 'src') },
  ] }, server: { host: '127.0.0.1', port: 0, fs: { allow: [client, root] },
    proxy: { '/api': { target: 'http://127.0.0.1:' + process.argv[2] } } },
});
await server.listen();
console.log('BROWSER_URL=http://127.0.0.1:' + server.httpServer.address().port);
process.on('SIGTERM', async () => { await server.close(); await rm(root, { recursive: true, force: true }); process.exit(0); });
