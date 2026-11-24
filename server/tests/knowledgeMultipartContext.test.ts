import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { once } from 'node:events';
import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import multer from 'multer';
import ts from 'typescript';
import { preserveAsyncContext } from '../middleware/preserveAsyncContext.js';
import { businessOwnerUserId, currentBusinessScope, requireBusinessScope } from '../tenancy/businessContext.js';
import { currentBillingScope, withBillingScope } from '../tenancy/billingContext.js';

const identities = [
  { userId: 101, businessProfileId: 201, actorUserId: 901, organizationId: 301 },
  { userId: 102, businessProfileId: 202, actorUserId: 902, organizationId: 302 },
];
// Exercise real business-profile middleware against a synthetic membership resolver.
jest.unstable_mockModule('../tenancy/businessScopeResolver.js', () => ({
  resolveBusinessScope: async (actor: number, profile?: number) => {
    const value = identities.find(item => item.actorUserId === actor && item.businessProfileId === profile);
    return value ? { userId: value.userId, businessProfileId: value.businessProfileId, actorUserId: actor, role: 'member' } : null;
  },
}));
const { businessProfileScope } = await import('../middleware/businessProfileScope.js');
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

// Mount the production KB registration statements and production Multer config
// without importing the unrelated monolithic app/provider initialization graph.
// Auth actor, authorized payer/module and terminal business writes are fixtures.
function declarations(path: string, prefix: string) {
  const text = source(path);
  return text.split('\n').filter(line => line.trimStart().startsWith(prefix + '.')
    && /^(app|router)\.(get|post|put|delete)\(['"](?:\/api)?\/knowledge-base/.test(line.trimStart()));
}
const canonical = declarations('../routes.ts', 'app');
const aliases = declarations('../routes/settings.routes.ts', 'router');
const controller = source('../controllers/knowledgeBaseController.ts');
const parserSource = controller.slice(controller.indexOf('const fileFilter ='), controller.indexOf('export async function getKnowledgeBaseEntries'));
const parserJs = ts.transpileModule(parserSource.replace('export const uploadMiddleware', 'const uploadMiddleware'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const parser = new Function('multer', `${parserJs}; return uploadMiddleware;`)(multer) as RequestHandler;
let parsed = 0;
let completed = 0;
const uploadMiddleware: RequestHandler = (req, res, next) => { parsed++; return parser(req, res, next); };
const snapshot = () => ({ business: currentBusinessScope() ?? null, billing: currentBillingScope() ?? null });
const uploadKnowledgeBaseFile: RequestHandler = (req, res) => {
  requireBusinessScope(); // Same fail-closed scope requirement as scoped DB work.
  completed++;
  res.json({ ...snapshot(), owner: businessOwnerUserId(req), actor: req.user?.id, bytes: req.file?.size });
};
const authenticateToken: RequestHandler = async (req, res, next) => {
  const identity = identities.find(item => String(item.actorUserId) === req.get('X-Synthetic-Actor'));
  if (!identity) { res.status(401).json({ code: 'UNAUTHENTICATED' }); return; }
  req.user = { id: identity.actorUserId } as Request['user'];
  await businessProfileScope(req, res, error => {
    if (error) return next(error);
    return withBillingScope({ organizationId: identity.organizationId, actorUserId: identity.actorUserId,
      businessProfileId: identity.businessProfileId, businessOwnerUserId: identity.userId }, next);
  });
};
const requireModuleAccess = () => (_req: Request, _res: Response, next: NextFunction) => next();
const app = express();
const router = express.Router();
const routeText = canonical.join('\n') + '\n' + aliases.join('\n');
const names = [...new Set([...routeText.matchAll(/,\s*([A-Za-z][\w]*)\s*\)/g)].map(match => match[1]))];
const values: Record<string, unknown> = { app, router, authenticateToken, preserveAsyncContext, uploadMiddleware, uploadKnowledgeBaseFile };
for (const name of names) if (!(name in values)) values[name] = (_req: Request, res: Response) => res.sendStatus(204);
new Function(...Object.keys(values), canonical.join('\n'))(...Object.values(values));
const settings = source('../routes/settings.routes.ts');
const guards = settings.split('\n').filter(line => /^router\.use\(authenticateToken\)/.test(line) || /^router\.use\('\/knowledge-base'/.test(line));
new Function(...Object.keys(values), 'requireModuleAccess', guards.join('\n') + '\n' + aliases.join('\n'))(...Object.values(values), requireModuleAccess);
app.use('/api/settings', router);
app.use((_req, res) => { res.status(404).json({ code: 'NOT_FOUND' }); });
app.use((error: Error & { code?: string }, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ error: error.code || error.message, ...snapshot() });
});
const server = app.listen(3139, '127.0.0.1');
beforeAll(async () => { if (!server.listening) await once(server, 'listening'); });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

async function send(path: string, identity: number, size = 2 * 1024 * 1024, options: { mime?: string; profile?: string | null; actor?: string } = {}) {
  const boundary = 'kb-synthetic-stream';
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.txt"\r\nContent-Type: ${options.mime || 'text/plain'}\r\n\r\n`), Buffer.alloc(size, 97), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: 3139, path, method: 'POST', headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length,
      'X-Synthetic-Actor': options.actor ?? String(identities[identity].actorUserId),
      ...(options.profile === null ? {} : { 'X-Business-Profile-Id': options.profile ?? String(identities[identity].businessProfileId) }),
    } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Synthetic KB stream timeout')));
    let offset = 0;
    const write = () => {
      if (req.destroyed) return;
      if (offset >= body.length) { req.end(); return; }
      const ready = req.write(body.subarray(offset, offset + 16384)); offset += 16384;
      if (ready) setImmediate(write); else req.once('drain', () => setImmediate(write));
    };
    write();
  });
}
function expectIdentity(body: Record<string, unknown>, index: number) {
  const value = identities[index];
  expect(body.business).toEqual({ kind: 'business', userId: value.userId, businessProfileId: value.businessProfileId, actorUserId: value.actorUserId, role: 'member' });
  expect(body.billing).toEqual({ organizationId: value.organizationId, actorUserId: value.actorUserId, businessProfileId: value.businessProfileId, businessOwnerUserId: value.userId });
}
describe('KB multipart continuation at both production registration sites', () => {
  it('retains exactly 18 canonical and 16 settings routes, without new crawl/url aliases', () => {
    expect(canonical).toHaveLength(18); expect(aliases).toHaveLength(16);
    expect(guards).toHaveLength(2);
    expect(aliases.some(line => /['"]\/knowledge-base\/(crawl-url|url)['"]/.test(line))).toBe(false);
  });
  it.each(['crawl-url', 'url'])('keeps settings POST /knowledge-base/%s unmounted', async suffix => {
    const before = { parsed, completed };
    const result = await send('/api/settings/knowledge-base/' + suffix, 0, 1024);
    expect(result.status).toBe(404);
    expect({ parsed, completed }).toEqual(before);
  });
  for (const path of ['/api/knowledge-base/upload', '/api/settings/knowledge-base/upload']) {
    it(`${path} preserves distinct actor, business and payer in concurrent streamed uploads`, async () => {
      const results = await Promise.all([send(path, 0), send(path, 1)]);
      results.forEach((result, index) => {
        expect(result.status).toBe(200); expectIdentity(result.body, index);
        expect(result.body).toMatchObject({ owner: identities[index].userId, actor: identities[index].actorUserId, bytes: 2 * 1024 * 1024 });
      });
    });
    it(`${path} retains parser size-limit failure and its owning scopes`, async () => {
      const before = completed;
      const result = await send(path, 1, 10 * 1024 * 1024 + 1);
      expect(result.status).toBe(400); expect(result.body.error).toBe('LIMIT_FILE_SIZE');
      expectIdentity(result.body, 1); expect(completed).toBe(before);
    });
    it(`${path} preserves the production MIME rejection`, async () => {
      const before = completed;
      const result = await send(path, 0, 1024, { mime: 'image/png' });
      expect(result.status).toBe(400); expect(result.body.error).toMatch(/^Invalid file type/);
      expect(completed).toBe(before);
    });
    it.each([[{ profile: null }, 409], [{ profile: '999' }, 403], [{ actor: '999' }, 401]] as const)(`${path} rejects invalid scope before parsing (%j)`, async (options, status) => {
      const before = parsed;
      const result = await send(path, 0, 1024, options);
      expect(result.status).toBe(status); expect(parsed).toBe(before);
    });
  }
});
