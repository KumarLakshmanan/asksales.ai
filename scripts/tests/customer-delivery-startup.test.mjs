import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const server = path.join(root, 'server');
const require = createRequire(path.join(server, 'package.json'));
const { build } = require('esbuild');
const syntheticDb = `await Promise.resolve();
  const chain=new Proxy(function(){return chain},{get(_target,key){return key==='then'?Promise.resolve([]).then.bind(Promise.resolve([])):()=>chain}});
  export const db={execute:async()=>({rows:[],rowCount:0}),select:()=>chain,insert:()=>chain,update:()=>chain,delete:()=>chain,transaction:async work=>work(db)};
  export const pgPool=undefined;`;
const syntheticEnv = {
  NODE_ENV:'test',SKIP_DB:'true',DB_HOST:'127.0.0.1',DB_PORT:'1',DB_USER:'synthetic',DB_PASSWORD:'synthetic',
  DB_NAME:'synthetic',DB_DATABASE:'synthetic',DB_SSL:'false',JWT_SECRET:'synthetic-startup-only-key-000000000000',JWT_EXPIRES_IN:'1h',
  CHANNEL_AUTH_ENCRYPTION_KEY:'a'.repeat(64),SECRETS_ENCRYPTION_KEY:'b'.repeat(64),REDIS_URL:'redis://127.0.0.1:1',
  RAZORPAY_KEY_SECRET:'synthetic-not-a-provider-key',TWILIO_ACCOUNT_SID:'',TWILIO_AUTH_TOKEN:'',TWILIO_PHONE_NUMBER:'',META_APP_ID:'',META_APP_SECRET:'',
  SUPPORT_ASSISTANTS_ENABLED:'false',DISABLE_BACKGROUND_JOBS:'true',LANGFUSE_ENABLED:'false',
  AD_PROVIDER_MUTATIONS_ENABLED:'false',SUPPORT_NOTIFICATION_DELIVERY_MODE:'simulate',DOTENV_OVERRIDE:'false',LOG_LEVEL:'error',
};

test('bundled delivery gate initializes with async DB and keeps runtime-off delivery blocked', async () => {
  const directory = await mkdtemp(path.join(server, '.customer-gate-startup-'));
  try {
    const output = path.join(directory, 'startup.mjs');
    await build({
      stdin: { contents: `import { assertCustomerDeliveryRuntime } from './services/assistants/CustomerDeliveryGate.ts';
        let blocked=false;try{assertCustomerDeliveryRuntime('email')}catch(error){blocked=error.code==='ASSISTANT_SETUP_REQUIRED'&&error.reason==='runtime_disabled'}
        if(!blocked)throw new Error('Runtime-off gate opened');console.log('CUSTOMER_GATE_STARTUP_OK');`,
        resolveDir: server, loader: 'ts' },
      outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
      plugins: [{ name: 'async-synthetic-db', setup(builder) {
        // Preserve top-level-await propagation: a synchronous Jest db mock hid the cycle.
        builder.onLoad({ filter: /[\\/]models[\\/]db\.ts$/ }, () => ({
          contents: syntheticDb, loader: 'ts',
        }));
      } }],
    });
    const child = spawnSync(process.execPath, ['--require', path.join(root, 'scripts/tests/no-network.cjs'), output], {
      cwd: server, encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, ...syntheticEnv },
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr.slice(-2000));
    assert.match(child.stdout, /CUSTOMER_GATE_STARTUP_OK/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [name, relative] of [['api', 'index.ts'], ['worker', 'workers/worker-entry.ts']]) {
  test(`bundled ${name} static startup reaches its entry body with async DB and runtime off`, async () => {
    const directory = await mkdtemp(path.join(server, '.customer-gate-startup-'));
    try {
      const output = path.join(directory, 'startup.mjs');
      const entry = path.join(server, relative);
      await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm',
        packages: 'external', logLevel: 'silent', plugins: [{name:'static-startup-boundary',setup(builder){
          builder.onLoad({filter:/[\\/]models[\\/]db\.ts$/},()=>({contents:syntheticDb,loader:'ts'}));
          builder.onLoad({filter:/[\\/](?:index|worker-entry)\.ts$/},async args=>{
            if(path.resolve(args.path)!==path.resolve(entry))return;
            return {contents:`console.log('BUNDLED_${name.toUpperCase()}_STARTUP_OK');process.exit(0);\n`+await readFile(entry,'utf8'),loader:'ts'};
          });
        }}] });
      const child=spawnSync(process.execPath,['--require',path.join(root,'scripts/tests/no-network.cjs'),output],{
        cwd:server,encoding:'utf8',timeout:15000,windowsHide:true,
        env:{...process.env,...syntheticEnv},
      });
      assert.ifError(child.error);assert.equal(child.status,0,(child.stderr+'\n'+child.stdout).slice(-3000));
      assert.match(child.stdout,new RegExp(`BUNDLED_${name.toUpperCase()}_STARTUP_OK`));
    } finally {await rm(directory,{recursive:true,force:true});}
  });
}
