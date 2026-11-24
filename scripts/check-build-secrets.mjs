import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8').split(/\r?\n/);
for (const pattern of ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/service-accounts/**', '**/*service-account*.json', '**/*credentials*.json']) {
  if (!ignore.includes(pattern)) throw new Error(`Missing recursive build exclusion: ${pattern}`);
}
// Emit only names/line numbers. Never echo a credential or matching line.
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const patterns = [
  ['cloud private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[A-Za-z0-9+/=\s\\nr]{200,}/g],
  ['Google API key', /AIza[\w-]{35}/g],
  ['provider API key', /(?:sk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{32,}|apify_api_[A-Za-z0-9]{30,}|gh[pousr]_[A-Za-z0-9]{36,}|AKIA[0-9A-Z]{16})/g],
  ['literal credential', /(?:apiKey|api_key|accessToken|apiToken|clientSecret|appSecret)\s*[:=]\s*(['"])([A-Za-z0-9_.\/-]{28,})\1/g],
];
let failed = false;
for (const name of tracked) {
  const file = path.join(root, name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size > 5 * 1024 * 1024) continue;
  if (!/\.(?:[cm]?[jt]sx?|json|ya?ml|toml|ini|conf|txt|sql|sh|ps1)$|(?:^|\/)\.env(?:\.|$)/i.test(name)) continue;
  const source = fs.readFileSync(file, 'utf8');
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (kind === 'literal credential' && /^(?:test|dummy|example|placeholder|replace|fake|not[-_]|x{8})|(?:test\d)/i.test(match[2])) continue;
      if (kind === 'literal credential' && new Set(match[2]).size < 20) continue;
      process.stderr.write(`${name}:${source.slice(0, match.index).split('\n').length}: remove ${kind}\n`);
      failed = true;
    }
  }
  if (/(?:^|\/)\.env(?:\.|$)/.test(name) && !name.endsWith('.example')) {
    source.split(/\r?\n/).forEach((line, index) => {
      const match = /^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && /(?:SECRET|PASSWORD|TOKEN|API_KEY|ENCRYPTION_KEY)$/.test(match[1]) && match[2].replace(/["']/g, '').trim()) {
        process.stderr.write(`${name}:${index + 1}: remove tracked value for ${match[1]}\n`);
        failed = true;
      }
    });
  }
}
if (failed) process.exitCode = 1;
else process.stdout.write('Tracked source, JSON, credential defaults, and build exclusions passed.\n');
