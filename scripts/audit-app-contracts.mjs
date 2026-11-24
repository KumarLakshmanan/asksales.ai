import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const ts = require('typescript');

const repoRoot = path.resolve(import.meta.dirname, '..');
const appRoot = path.join(repoRoot, 'client/src/app');
const clientRoot = path.join(repoRoot, 'client/src');
const serverRoot = path.join(repoRoot, 'server');
const docsRoot = path.join(repoRoot, 'docs');


function walk(root, predicate = () => true) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute, predicate));
    else if (predicate(absolute)) files.push(absolute);
  }
  return files;
}

function relative(file) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

function resolveClientModule(fromFile, specifier) {
  let base;
  if (specifier.startsWith('@/')) base = path.join(clientRoot, specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;

  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, 'index.tsx'),
    path.join(base, 'index.ts'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function composedComponentSources(file, source, depth = 2, seen = new Set([file])) {
  if (depth <= 0) return [];
  const results = [];
  for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (specifier.startsWith('@/components/ui/') || specifier.startsWith('@/lib/') || specifier.startsWith('@/hooks/')) continue;
    const resolved = resolveClientModule(file, specifier);
    if (!resolved || seen.has(resolved) || !resolved.startsWith(clientRoot)) continue;
    seen.add(resolved);
    const importedSource = fs.readFileSync(resolved, 'utf8');
    results.push(importedSource);
    results.push(...composedComponentSources(resolved, importedSource, depth - 1, seen));
  }
  return results;
}

function md(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function appRouteFor(file) {
  const directory = path.relative(appRoot, path.dirname(file));
  const segments = directory
    .split(path.sep)
    .filter(Boolean)
    .filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')));
  return `/${segments.join('/')}`.replace(/\/$/, '') || '/';
}

function surfaceFor(route) {
  if (route === '/admin' || route.startsWith('/admin/')) return 'Admin';
  if (route === '/support' || route.startsWith('/support/')) return 'Support member';
  if (route.startsWith('/dashboard') || route.startsWith('/setup')) return 'User';
  if (route.startsWith('/support-widget')) return 'Public widget';
  if (route.startsWith('/proposal/') || route.startsWith('/review/')) return 'Public token';
  return 'Public/auth';
}

function isRedirectOnlyPage(source) {
  if (/\b(?:redirect|redirectOutreachInbox|redirectOutreachCreation)\s*\(/.test(source)) return true;
  const lineCount = source.split('\n').length;
  if (lineCount > 45 || !/\brouter\.(?:replace|push)\s*\(/.test(source)) return false;
  // Transitional route aliases often render only a spinner/loading state while
  // replacing the URL. They do not own a responsive application layout.
  return !/<(?:form|input|select|textarea|table)\b/i.test(source);
}

function nearestBoundary(file, boundaryName) {
  let directory = path.dirname(file);
  while (directory.startsWith(appRoot)) {
    if (fs.existsSync(path.join(directory, `${boundaryName}.tsx`))) {
      return relative(path.join(directory, `${boundaryName}.tsx`));
    }
    if (directory === appRoot) break;
    directory = path.dirname(directory);
  }
  return 'Missing';
}

function normalizeEndpoint(raw) {
  // The lightweight call scanner intentionally avoids evaluating source. If a
  // template expression itself contains a nested template literal (typically a
  // conditional query string), its regex capture ends at that inner backtick.
  // Discard only that unterminated suffix so the stable pathname remains useful.
  const interpolationStarts = raw.match(/\$\{/g)?.length ?? 0;
  const interpolationEnds = raw.match(/\}/g)?.length ?? 0;
  const safeRaw = interpolationStarts > interpolationEnds
    ? raw.slice(0, raw.lastIndexOf('${'))
    : raw;
  const withoutDynamicQuery = safeRaw.replace(
    /\$\{(?:query|queryParam|queryParams|queryString|params|searchParams)[^}]*\}$/i,
    '',
  );
  const replaced = withoutDynamicQuery
    .replace(/\$\{[^}]+\}/g, ':param')
    .replace(/\\`/g, '`')
    .trim();
  const withoutOrigin = replaced.replace(/^https?:\/\/[^/]+/i, '');
  return (withoutOrigin.split(/[?#]/, 1)[0] || '/').replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

function extractApiCalls(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const paths = node => {
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isTemplateExpression(node)) {
      let variants = [node.head.text];
      for (const span of node.templateSpans) {
        const known = paths(span.expression);
        const name = ts.isIdentifier(span.expression) ? span.expression.text : 'param';
        const suffixes = known.length ? known : [`\${${name}}`];
        variants = variants.flatMap(prefix => suffixes.map(suffix => prefix + suffix + span.literal.text));
      }
      return variants;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = paths(node.left), right = paths(node.right);
      return left.flatMap(value => (right.length ? right : ['${param}']).map(suffix => value + suffix));
    }
    if (ts.isConditionalExpression(node)) return [...paths(node.whenTrue), ...paths(node.whenFalse)];
    return [];
  };
  const calls = [];
  const visit = node => {
    if (ts.isCallExpression(node) && node.arguments[0]) {
      let method, transport;
      if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && ['api', 'supportApi'].includes(node.expression.expression.text) && ['get', 'post', 'put', 'patch', 'delete', 'postForm', 'upload'].includes(node.expression.name.text)) {
        transport = node.expression.expression.text;
        method = ['postForm', 'upload'].includes(node.expression.name.text) ? 'POST' : node.expression.name.text.toUpperCase();
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
        transport = 'fetch'; method = 'GET';
        const options = node.arguments[1];
        if (options && ts.isObjectLiteralExpression(options)) for (const prop of options.properties) if (ts.isPropertyAssignment(prop) && prop.name.getText(ast).replace(/['"]/g, '') === 'method' && ts.isStringLiteralLike(prop.initializer)) method = prop.initializer.text.toUpperCase();
      }
      if (method) for (const raw of paths(node.arguments[0])) if (raw.startsWith('/api/')) calls.push({ transport, method, raw, endpoint: normalizeEndpoint(raw), source: relative(file), line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return calls;
}

function joinRoute(prefix, route) {
  const left = prefix.replace(/\/$/, '');
  const right = route === '/' ? '' : `/${route.replace(/^\//, '')}`;
  return `${left}${right}` || '/';
}

function extractServerRoutes() {
  // Follow imported/re-exported router symbols and actual .use() mounts.
  // A router's variable name and file basename do not determine its URL.
  const files = walk(serverRoot, file => file.endsWith('.ts') && !file.includes(`${path.sep}tests${path.sep}`) && !file.includes(`${path.sep}node_modules${path.sep}`) && !file.includes(`${path.sep}dist${path.sep}`));
  const modules = new Map();
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);
  const resolveModule = (file, specifier) => {
    if (!specifier.startsWith('.')) return null;
    const base = path.resolve(path.dirname(file), specifier).replace(/\.js$/, '');
    return [base, `${base}.ts`, path.join(base, 'index.ts')].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
  };
  const literalPaths = node => ts.isStringLiteralLike(node) ? [node.text] : ts.isArrayLiteralExpression(node) ? node.elements.flatMap(literalPaths) : [];
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const info = { imports: new Map(), exports: new Map(), routers: new Set(), rewrites: new Set(), routes: [], mounts: [] };
    modules.set(file, info);
    const visit = node => {
      if (ts.isImportDeclaration(node) && node.importClause) {
        const target = resolveModule(file, node.moduleSpecifier.text);
        if (target) {
          if (node.importClause.name) info.imports.set(node.importClause.name.text, { file: target, name: 'default' });
          const bindings = node.importClause.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) for (const entry of bindings.elements) info.imports.set(entry.name.text, { file: target, name: entry.propertyName?.text || entry.name.text });
        }
      }
      if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) info.exports.set('default', { file, local: node.expression.text });
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        const target = node.moduleSpecifier ? resolveModule(file, node.moduleSpecifier.text) : file;
        for (const entry of node.exportClause.elements) info.exports.set(entry.name.text, node.moduleSpecifier ? { file: target, name: entry.propertyName?.text || entry.name.text } : { file, local: entry.propertyName?.text || entry.name.text });
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && /(?:^|\.)Router$/.test(node.initializer.expression.getText(source))) {
        info.routers.add(node.name.text);
        if (node.parent?.parent?.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) info.exports.set(node.name.text, { file, local: node.name.text });
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
        const owner = node.expression.expression.text, method = node.expression.name.text;
        if (methods.has(method) && node.arguments[0]) for (const route of literalPaths(node.arguments[0])) info.routes.push({ owner, method: method.toUpperCase(), declared: route, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
        if (method === 'use') {
          if (node.arguments.some(arg => /\breq\.url\s*=/.test(arg.getText(source)))) info.rewrites.add(owner);
          const prefixes = node.arguments[0] ? literalPaths(node.arguments[0]) : [];
          const start = prefixes.length ? 1 : 0;
          for (const arg of node.arguments.slice(start)) if (ts.isIdentifier(arg)) info.mounts.push({ owner, child: arg.text, prefixes: prefixes.length ? prefixes : [''] });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const resolveSymbol = (file, name, exported = false, seen = new Set()) => {
    const key = `${file}:${name}:${exported}`;
    if (!file || seen.has(key)) return null;
    seen.add(key);
    const info = modules.get(file);
    if (!info) return null;
    if (exported) {
      const entry = info.exports.get(name);
      return entry ? resolveSymbol(entry.file, entry.local || entry.name, !entry.local, seen) : null;
    }
    if (info.routers.has(name)) return { file, owner: name };
    const imported = info.imports.get(name);
    return imported ? resolveSymbol(imported.file, imported.name, true, seen) : null;
  };
  const routes = [], visited = new Set();
  const traverse = (file, owner, prefix) => {
    const key = `${file}:${owner}:${prefix}`;
    if (visited.has(key)) return;
    visited.add(key);
    const info = modules.get(file);
    for (const route of info.routes.filter(route => route.owner === owner)) {
      const endpoint = joinRoute(prefix, route.declared);
      if (endpoint.startsWith('/api')) routes.push({ method: route.method, endpoint: normalizeEndpoint(endpoint), source: relative(file), line: route.line });
    }
    // URL rewriting needs behavioral review, never an inferred direct mount.
    if (info.rewrites.has(owner)) return;
    for (const mount of info.mounts.filter(mount => mount.owner === owner)) {
      const target = resolveSymbol(file, mount.child);
      if (target) for (const childPrefix of mount.prefixes) traverse(target.file, target.owner, childPrefix ? joinRoute(prefix, childPrefix) : prefix);
    }
  };
  for (const file of [path.join(serverRoot, 'index.ts'), path.join(serverRoot, 'routes.ts')]) {
    if (modules.has(file)) traverse(file, 'app', '');
  }
  return routes;
}

function routeMatches(clientEndpoint, serverEndpoint) {
  const clientSegments = clientEndpoint.split('/').filter(Boolean);
  const serverSegments = serverEndpoint.split('/').filter(Boolean);
  if (clientSegments.length !== serverSegments.length) return false;
  return clientSegments.every((segment, index) => {
    const candidate = serverSegments[index];
    return segment === candidate
      || segment.startsWith(':')
      || candidate.startsWith(':')
      || candidate === '*';
  });
}

function apiSurface(source) {
  if (source.includes('/app/admin/') || source.includes('/components/admin/') || source.includes('/lib/admin-api')) return 'Admin';
  if (source.includes('/app/support/') || source.includes('/lib/support-api')) return 'Support member';
  return 'User/public';
}

const pageFiles = walk(appRoot, (file) => /\/page\.(?:ts|tsx|js|jsx)$/.test(file)).sort();
const sourceFiles = walk(clientRoot, (file) => /\.(?:ts|tsx)$/.test(file) && !file.includes(`${path.sep}__tests__${path.sep}`));
const allApiCalls = sourceFiles.flatMap((file) => extractApiCalls(file, fs.readFileSync(file, 'utf8')));
const serverRoutes = extractServerRoutes();

const pages = pageFiles.map((file) => {
  const source = fs.readFileSync(file, 'utf8');
  const composedSources = composedComponentSources(file, source);
  const hasDirectResponsiveSignal = /\b(?:sm|md|lg|xl|2xl):/.test(source);
  const hasComposedResponsiveSignal = composedSources.some((item) => /\b(?:sm|md|lg|xl|2xl):/.test(item));
  const redirectOnly = isRedirectOnlyPage(source);
  const route = appRouteFor(file);
  return {
    route,
    surface: surfaceFor(route),
    source: relative(file),
    lines: source.split('\n').length,
    apiCalls: extractApiCalls(file, source).length,
    literalColors: (source.match(/(?:bg|text|border|ring|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)-/g) || []).length,
    responsive: redirectOnly ? 'N/A (redirect)' : hasDirectResponsiveSignal ? 'Yes' : hasComposedResponsiveSignal ? 'Inherited' : 'Review',
    loading: nearestBoundary(file, 'loading'),
    error: nearestBoundary(file, 'error'),
  };
});

const groupedCalls = new Map();
for (const call of allApiCalls) {
  const key = `${call.method} ${call.endpoint}`;
  const existing = groupedCalls.get(key) || { ...call, sources: new Set() };
  existing.sources.add(`${call.source}:${call.line}`);
  groupedCalls.set(key, existing);
}

const apiRows = [...groupedCalls.values()].sort((a, b) => (
  a.endpoint.localeCompare(b.endpoint) || a.method.localeCompare(b.method)
)).map((call) => {
  const matches = serverRoutes.filter((route) => (
    (route.method === call.method || route.method === 'ALL') && routeMatches(call.endpoint, route.endpoint)
  ));
  const samePath = serverRoutes.some((route) => routeMatches(call.endpoint, route.endpoint));
  const dynamic = call.raw.includes('${') && call.endpoint.includes(':param');
  return {
    ...call,
    sources: [...call.sources].sort(),
    status: matches.length ? 'Matched' : dynamic ? 'Dynamic review' : samePath ? 'Method review' : 'Route review',
    backend: matches.map((match) => `${match.source}:${match.line}`).slice(0, 3),
  };
});

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const surfaceCounts = new Map();
for (const page of pages) surfaceCounts.set(page.surface, (surfaceCounts.get(page.surface) || 0) + 1);
const redirectCount = pages.filter((page) => page.responsive === 'N/A (redirect)').length;
const responsivePageCount = pages.filter((page) => page.responsive === 'Yes' || page.responsive === 'Inherited').length;
const layoutPageCount = pages.length - redirectCount;
const pageLines = [
  '# Client Page Inventory',
  '',
  `Generated from the current source on ${today} by \`scripts/audit-app-contracts.mjs\`. This proves static route coverage; it does not by itself prove runtime workflow correctness.`,
  '',
  '## Summary',
  '',
  `- Page files/routes: **${pages.length}**`,
  ...[...surfaceCounts].sort().map(([surface, count]) => `- ${surface}: **${count}**`),
  `- Pages inheriting a loading boundary: **${pages.filter((page) => page.loading !== 'Missing').length}**`,
  `- Pages inheriting an error boundary: **${pages.filter((page) => page.error !== 'Missing').length}**`,
  `- Redirect-only compatibility routes with no owned layout: **${redirectCount}**`,
  `- Layout-owning pages with direct or composed responsive signals: **${responsivePageCount}/${layoutPageCount}**`,
  `- Pages with literal palette utility references requiring visual review: **${pages.filter((page) => page.literalColors > 0).length}**`,
  '',
  '## Route inventory',
  '',
  '| Route | Surface | Source | Lines | Direct API calls | Literal colors | Responsive signal | Loading boundary | Error boundary |',
  '| --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |',
  ...pages.map((page) => `| \`${md(page.route)}\` | ${page.surface} | \`${page.source}\` | ${page.lines} | ${page.apiCalls} | ${page.literalColors} | ${page.responsive} | \`${page.loading}\` | \`${page.error}\` |`),
  '',
];

const matchedCount = apiRows.filter((row) => row.status === 'Matched').length;
const apiLines = [
  '# API Contract Matrix',
  '',
  `Generated from static client and Express route declarations on ${today} by \`scripts/audit-app-contracts.mjs\`. Dynamic and indirectly constructed paths remain explicitly marked for review rather than being assumed valid.`,
  '',
  '## Contract rules',
  '',
  '- Browser calls use same-origin `/api/...` unless an explicitly external provider is required.',
  '- User, administrator, and support-member credentials remain separate.',
  '- Shared transport owns URL normalization, JSON parsing, CSRF headers, standardized errors, and response-envelope handling.',
  '- Every mutation must expose pending, success, actionable error, and cache-invalidation behavior.',
  '- Mount discovery follows TypeScript imports/re-exports and router variables. URL-rewriting middleware, computed paths and runtime feature gates still require behavioral review.',
  '',
  '## Static coverage summary',
  '',
  `- Client API method call sites found: **${allApiCalls.length}**`,
  `- Unique method/path contracts: **${apiRows.length}**`,
  `- Statically matched to a registered Express route: **${matchedCount}**`,
  `- Explicit review items (dynamic, indirect mount, or possible mismatch): **${apiRows.length - matchedCount}**`,
  `- Registered Express method/path declarations inventoried: **${serverRoutes.length}**`,
  '',
  '## Active client contracts',
  '',
  '| Surface | Method | Client path | Client sources | Backend evidence | Static status |',
  '| --- | --- | --- | --- | --- | --- |',
  ...apiRows.map((row) => `| ${apiSurface(row.source)} | ${row.method} | \`${md(row.endpoint)}\` | ${row.sources.slice(0, 4).map((item) => `\`${item}\``).join('<br>')}${row.sources.length > 4 ? `<br>+${row.sources.length - 4} more` : ''} | ${row.backend.length ? row.backend.map((item) => `\`${item}\``).join('<br>') : 'Manual mount/route review'} | ${row.status} |`),
  '',
];

fs.mkdirSync(docsRoot, { recursive: true });
fs.writeFileSync(path.join(docsRoot, 'CLIENT_PAGE_INVENTORY.md'), `${pageLines.join('\n')}\n`);
fs.writeFileSync(path.join(docsRoot, 'API_CONTRACT_MATRIX.md'), `${apiLines.join('\n')}\n`);

console.log(JSON.stringify({
  pages: pages.length,
  apiCallSites: allApiCalls.length,
  uniqueApiContracts: apiRows.length,
  matchedContracts: matchedCount,
  serverRoutes: serverRoutes.length,
}, null, 2));
