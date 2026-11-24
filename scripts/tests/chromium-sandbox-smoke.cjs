const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');

function processSandbox(pid) {
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const field = name => status.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1];
  return { namespaceDepth: field('NSpid')?.trim().split(/\s+/).length || 0,
    seccomp: Number(field('Seccomp')), filters: Number(field('Seccomp_filters')),
    noNewPrivileges: Number(field('NoNewPrivs')) };
}

(async () => {
  assert.notEqual(process.getuid(), 0, 'The browser must run as a non-root user');
  let browser;
  let requests = 0;
  const listener = http.createServer((_req, res) => { requests++; res.end('blocked fixture'); });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  try {
    const { launchSystemChromium } = await import('/app/server/dist/browserAutomation.js');
    browser = await launchSystemChromium({ untrustedContent: true });
    const page = await browser.newPage({ javaScriptEnabled: false, serviceWorkers: 'block' });
    await page.setContent('<!doctype html><title>isolated sandbox test</title><p>safe fixture</p>');
    const screenshot = await page.screenshot({ type: 'png', timeout: 10000 });
    assert.equal(screenshot.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    // Kernel state proves sandboxing independently of Chromium's WebUI labels.
    const baseline = processSandbox('self');
    const renderers = fs.readdirSync('/proc').filter(pid => /^\d+$/.test(pid)).flatMap(pid => {
      try {
        if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=renderer')) return [];
        return [processSandbox(pid)];
      } catch { return []; } // A child may exit while /proc is enumerated.
    });
    assert(renderers.length > 0, 'No renderer process was available to verify');
    for (const renderer of renderers) {
      assert(renderer.namespaceDepth > baseline.namespaceDepth, 'Renderer has no nested PID namespace');
      assert.equal(renderer.seccomp, 2, 'Renderer has no seccomp filter');
      assert(renderer.filters > baseline.filters, 'Renderer has no Chromium-specific seccomp filter');
      assert.equal(renderer.noNewPrivileges, 1, 'Renderer may acquire new privileges');
    }
    await assert.rejects(page.goto(`http://127.0.0.1:${listener.address().port}/`, { timeout: 3000 }));
    assert.equal(requests, 0, 'The browser bypassed the proxy backstop');
    console.log(JSON.stringify({ isolatedLinuxSandbox: 'passed', uid: process.getuid(),
      nodeVersion: process.version, browserVersion: browser.version(),
      namespaceSandbox: true, seccompSandbox: true, screenshotBytes: screenshot.length,
      baselineNamespaceDepth: baseline.namespaceDepth,
      minRendererNamespaceDepth: Math.min(...renderers.map(renderer => renderer.namespaceDepth)),
      baselineSeccompFilters: baseline.filters,
      minRendererSeccompFilters: Math.min(...renderers.map(renderer => renderer.filters)),
      renderersVerified: renderers.length, directLoopbackRequests: requests, externalNetwork: 'disabled' }));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => listener.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
