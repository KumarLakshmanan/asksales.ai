// Author-time tooling only; the deployed client uses reviewed same-origin SVGs.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('@playwright/test');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const sourceDir = path.join(__dirname, 'diagrams');
  const targetDir = path.join(root, 'client/public/documentation/diagrams');
  fs.mkdirSync(targetDir, { recursive: true });
  const script = fs.readFileSync(path.join(__dirname, 'node_modules/mermaid/dist/mermaid.min.js'));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/mermaid.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/mermaid.js' ? script : '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.DOCS_BROWSER_PATH ? { executablePath: process.env.DOCS_BROWSER_PATH } : {}) });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addScriptTag({ url: '/mermaid.js' });
    await page.evaluate(() => mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, look: 'classic', handDrawnSeed: 42, theme: 'base', deterministicIds: true, deterministicIDSeed: 'asksales-docs', fontFamily: 'Arial, sans-serif', flowchart: { htmlLabels: false, useMaxWidth: true }, themeVariables: { primaryColor: '#eef2ff', primaryTextColor: '#172033', primaryBorderColor: '#64748b', lineColor: '#64748b', secondaryColor: '#f1f5f9', tertiaryColor: '#ffffff' } }));
    for (const file of fs.readdirSync(sourceDir).filter(file => file.endsWith('.mmd')).sort()) {
      const source = fs.readFileSync(path.join(sourceDir, file), 'utf8');
      if (!source.includes('accTitle:') || !source.includes('accDescr:')) throw new Error(`${file}: accessibility metadata missing`);
      const id = path.basename(file, '.mmd');
      const svg = await page.evaluate(async ({ source, id }) => (await mermaid.render(`docs-${id}`, source)).svg, { source, id });
      if (/<script\b|<foreignObject\b|(?:href|src)=["'](?:https?:|javascript:)/i.test(svg)) throw new Error(`${file}: unexpected active or external SVG content: ${svg.match(/.{0,60}(?:<script\b|<foreignObject\b|(?:href|src)=["'](?:https?:|javascript:)).{0,100}/i)?.[0]}`);
      fs.writeFileSync(path.join(targetDir, `${id}.svg`), svg.replace(/\r\n/g, '\n') + '\n');
      console.log(`Rendered ${id}`);
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
