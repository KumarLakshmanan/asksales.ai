const fs = require('node:fs');
const path = require('node:path');
const ts = require('../../client/node_modules/typescript');
const root = path.resolve(__dirname, '../..');
const cache = new Map();

// Read-only loading of the guide's data and navigation metadata for auditing.
function loadTs(filename) {
  const resolved = fs.existsSync(`${filename}.ts`) ? `${filename}.ts` : path.join(filename, 'index.ts');
  if (cache.has(resolved)) return cache.get(resolved);
  const result = { exports: {} };
  cache.set(resolved, result.exports);
  const code = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (!name.startsWith('.')) throw new Error(`Unexpected audit dependency: ${name}`);
    return loadTs(path.resolve(path.dirname(resolved), name));
  }, result, result.exports);
  return result.exports;
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}

const { documentationArticles } = loadTs(path.join(root, 'client/src/content/documentation'));
const { documentationHrefForPath } = loadTs(path.join(root, 'client/src/lib/documentation-navigation'));
const { moduleForDashboardPath, isHiddenDashboardPath } = loadTs(path.join(root, 'client/src/lib/platform-access'));
const app = path.join(root, 'client/src/app');
const pages = walk(app).filter(file => path.basename(file) === 'page.tsx');
const routes = pages.map(file => {
  const relative = path.relative(app, path.dirname(file)).replaceAll('\\', '/');
  const route = '/' + relative.split('/').filter(part => !part.startsWith('(')).join('/');
  const contextualHelp = documentationHrefForPath(route);
  return { route, source: path.relative(root, file).replaceAll('\\', '/'), module: route.startsWith('/dashboard/settings/outreach') ? 'support_ai' : moduleForDashboardPath(route), hidden: isHiddenDashboardPath(route), contextualHelp, sourceContainsRedirect: /(?:redirect|router\.replace)\s*\(/.test(fs.readFileSync(file, 'utf8')) };
}).filter(page => page.route.startsWith('/dashboard/')).sort((a, b) => a.route.localeCompare(b.route));
const missingEvidence = documentationArticles.flatMap(article => article.evidence.filter(file => !fs.existsSync(path.join(root, file))).map(source => ({ topic: article.slug, source })));
const missingLinks = documentationArticles.flatMap(article => article.destinations.filter(item => !routes.some(page => page.route === item.href || page.route.replace(/\/\[\[\.\.\.[^\]]+\]\]$/, '') === item.href)).map(item => ({ topic: article.slug, href: item.href })));
const moduleRoutesWithoutGuide = routes.filter(page => page.module && !page.hidden && !page.contextualHelp);
const diagrams = documentationArticles.flatMap(article => article.sections.flatMap(section => section.diagram ? [{ topic: article.slug, ...section.diagram }] : []));
const inventory = {
  baseline: '10d00c7262d372dd7830a0b146209babcd319e64',
  note: 'Source and navigation inventory only. It does not prove any live workflow or provider integration succeeds.',
  topics: documentationArticles.map(article => ({ slug: article.slug, title: article.title, group: article.group, evidence: article.evidence, destinations: article.destinations })),
  modules: [...new Set(routes.map(page => page.module).filter(Boolean))].sort(),
  diagrams, routes, missingEvidence, missingLinks, moduleRoutesWithoutGuide,
};
fs.writeFileSync(path.join(__dirname, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
console.log(JSON.stringify({ topics: inventory.topics.length, diagrams: diagrams.length, dashboardRoutes: routes.length, modules: inventory.modules, missingEvidence, missingLinks, moduleRoutesWithoutGuide }, null, 2));
if (missingEvidence.length || missingLinks.length || moduleRoutesWithoutGuide.length) process.exitCode = 1;
