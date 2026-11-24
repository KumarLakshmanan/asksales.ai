// Synthetic database only. Run as its administrator; no production data is read
// or changed. The real legacy guard and migration are exercised under the actual
// application's non-bypass-RLS role, including its AFTER constraint trigger.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { up, down } from '../migrations/577_index_business_ownership_parent_lookups.js';

const require = createRequire(process.env.OWNERSHIP_QA_PACKAGE || import.meta.url);
const { Client } = require('pg');
const database = process.env.OWNERSHIP_QA_DATABASE;
if (!/^asksales_guard_prefilter_qa_[a-z0-9_]+$/.test(database || '')) {
  throw new Error('An explicitly named synthetic ownership QA database is required');
}
const client = new Client({ host: '/var/run/postgresql', user: 'postgres', database });
let passed = 0;
await client.connect();
try {
  assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, database);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0,
    'Refusing to modify a non-empty database');
  const legacySource = await readFile(new URL('../migrations/299_business_profile_isolation.js', import.meta.url), 'utf8');
  const start = legacySource.indexOf('CREATE OR REPLACE FUNCTION enforce_business_ownership()');
  assert.ok(start >= 0);
  const legacy = legacySource.slice(start, legacySource.indexOf('END $$', start) + 'END $$'.length);
  await client.query(`
    CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.business_profile_id',true),'')::integer $$;
    CREATE FUNCTION app_business_user_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.current_user_id',true),'')::integer $$;
    CREATE FUNCTION app_business_system() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('app.business_system',true)='on',false) $$;
    CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer);
    INSERT INTO company_settings VALUES(7,9),(8,10);
    CREATE TABLE qa_guard_parent(id integer PRIMARY KEY,business_profile_id integer NOT NULL);
    INSERT INTO qa_guard_parent SELECT n,CASE WHEN n=2 THEN 8 ELSE 7 END FROM generate_series(1,10000) n;
    CREATE TABLE qa_guard_visible_parent(id integer PRIMARY KEY,business_profile_id integer NOT NULL);
    INSERT INTO qa_guard_visible_parent VALUES(1,7),(2,8);
    CREATE TABLE qa_guard_uuid(id uuid PRIMARY KEY,business_profile_id integer NOT NULL);
    INSERT INTO qa_guard_uuid VALUES('aaaaaaaa-1111-2222-3333-444444444444',7);
    CREATE TABLE qa_guard_text(id text PRIMARY KEY,business_profile_id integer NOT NULL);
    INSERT INTO qa_guard_text VALUES('01',7),('Exact',7);
    CREATE TABLE qa_guard_composite(id bigint,code text,business_profile_id integer NOT NULL,PRIMARY KEY(id,code));
    INSERT INTO qa_guard_composite VALUES(1,'one',7),(1,'two',8);
    CREATE TABLE qa_guard_child(id integer PRIMARY KEY,user_id integer,business_profile_id integer,
      parent_id text,visible_parent_id text,uuid_parent_id text,text_parent_id text,composite_id text,composite_code text);
    GRANT USAGE ON SCHEMA public TO salesmarketing_business_runtime;
    GRANT SELECT ON company_settings,qa_guard_parent,qa_guard_visible_parent,qa_guard_uuid,qa_guard_text,qa_guard_composite TO salesmarketing_business_runtime;
    GRANT SELECT,INSERT,UPDATE ON qa_guard_child TO salesmarketing_business_runtime;
    ALTER TABLE qa_guard_child ENABLE ROW LEVEL SECURITY;
    CREATE POLICY child_scope ON qa_guard_child USING(business_profile_id=app_business_profile_id()) WITH CHECK(business_profile_id=app_business_profile_id());
    ANALYZE qa_guard_parent;
  `);
  for (const table of ['qa_guard_parent','qa_guard_uuid','qa_guard_text','qa_guard_composite']) {
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY parent_scope ON ${table} USING(business_profile_id=app_business_profile_id());`);
  }
  await client.query(legacy);
  const spec = JSON.stringify({ owner_column: 'user_id', global_read: false, parent_links: [
    {parent:'qa_guard_parent',child_columns:['parent_id'],parent_columns:['id']},
    {parent:'qa_guard_visible_parent',child_columns:['visible_parent_id'],parent_columns:['id']},
    {parent:'qa_guard_uuid',child_columns:['uuid_parent_id'],parent_columns:['id']},
    {parent:'qa_guard_text',child_columns:['text_parent_id'],parent_columns:['id']},
    {parent:'qa_guard_composite',child_columns:['composite_id','composite_code'],parent_columns:['id','code']},
  ] });
  await client.query(`CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON qa_guard_child
    FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${spec}');
    CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON qa_guard_child
    NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${spec}');
    CREATE FUNCTION qa_guard_tamper() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id=900 THEN NEW.user_id:=10; END IF; RETURN NEW; END $$;
    CREATE TRIGGER zzz_later_tamper BEFORE INSERT ON qa_guard_child FOR EACH ROW EXECUTE FUNCTION qa_guard_tamper();`);
  async function runtime(run) {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL ROLE salesmarketing_business_runtime;
        SET LOCAL app.business_profile_id='7'; SET LOCAL app.current_user_id='9'; SET LOCAL app.business_system='off';`);
      return await run();
    } finally { await client.query('ROLLBACK'); }
  }
  async function rejects(sql, code) {
    await assert.rejects(runtime(() => client.query(sql)), error => error.code === code);
    passed++;
  }
  async function securityCases() {
    await runtime(async () => {
      await client.query(`INSERT INTO qa_guard_child VALUES(1,9,7,'1',NULL,'aaaaaaaa-1111-2222-3333-444444444444','01','1','one')`);
      await client.query('INSERT INTO qa_guard_child(id,user_id,business_profile_id) VALUES(3,9,7)');
      assert.equal((await client.query('SELECT count(*)::int AS n FROM qa_guard_child')).rows[0].n,2);
    }); passed++;
    await rejects("INSERT INTO qa_guard_child(id,user_id,business_profile_id,parent_id) VALUES(4,9,7,'2')", '23503');
    await rejects("INSERT INTO qa_guard_child(id,user_id,business_profile_id,visible_parent_id) VALUES(4,9,7,'2')", '23514');
    await rejects("INSERT INTO qa_guard_child(id,user_id,business_profile_id) VALUES(4,10,7)", '23514');
    await rejects("INSERT INTO qa_guard_child(id,user_id,business_profile_id) VALUES(4,10,8)", '42501');
    await rejects("INSERT INTO qa_guard_child(id,user_id,business_profile_id,parent_id) VALUES(4,9,7,'01')", '23503');
    await rejects("INSERT INTO qa_guard_child(id,user_id,business_profile_id,uuid_parent_id) VALUES(4,9,7,'AAAAAAAA-1111-2222-3333-444444444444')", '23503');
    await rejects("INSERT INTO qa_guard_child(id,user_id,business_profile_id,text_parent_id) VALUES(4,9,7,'exact')", '23503');
    await rejects("INSERT INTO qa_guard_child(id,user_id,business_profile_id,composite_id,composite_code) VALUES(4,9,7,'1','two')", '23503');
    await rejects("INSERT INTO qa_guard_child(id,user_id,business_profile_id,parent_id) VALUES(900,9,7,'1')", '23514');
    await assert.rejects(runtime(async () => {
      await client.query("INSERT INTO qa_guard_child(id,user_id,business_profile_id,parent_id) VALUES(4,9,7,'1')");
      await client.query('UPDATE qa_guard_child SET business_profile_id=8 WHERE id=4');
    }), error => error.code === '23514'); passed++;
  }
  async function benchmark() {
    return runtime(async () => {
      const startTime = performance.now();
      await client.query("INSERT INTO qa_guard_child(id,user_id,business_profile_id,parent_id) SELECT n,9,7,'9999' FROM generate_series(100,124) n");
      return Math.round((performance.now()-startTime)*100)/100;
    });
  }
  await securityCases();
  const beforeMs = await benchmark();
  const originalDefinition=(await client.query("SELECT pg_get_functiondef('public.enforce_business_ownership()'::regprocedure) AS definition")).rows[0].definition;
  await up(client); await up(client);
  await securityCases();
  const afterMs = await benchmark();
  const triggers=(await client.query("SELECT tgname FROM pg_trigger WHERE tgrelid='qa_guard_child'::regclass AND NOT tgisinternal ORDER BY tgname")).rows.map(row=>row.tgname);
  assert.deepEqual(triggers,['business_ownership_guard','zz_business_ownership','zzz_later_tamper']); passed++;
  const plans = await runtime(async () => {
    const out=[];
    for (const predicate of ["id::text='9999'","id='9999'::integer AND id::text='9999'"]) {
      const plan=(await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT to_jsonb(p) FROM qa_guard_parent p WHERE ${predicate}`)).rows[0]['QUERY PLAN'][0];
      out.push({ node:plan.Plan['Node Type'], executionMs:plan['Execution Time'] });
    }
    return out;
  });
  assert.equal(plans[1].node,'Index Scan'); passed++;
  await down(client); await down(client);
  assert.equal((await client.query("SELECT pg_get_functiondef('public.enforce_business_ownership()'::regprocedure) AS definition")).rows[0].definition,originalDefinition); passed++;
  await securityCases();
  await up(client);
  console.log(JSON.stringify({status:'passed',checks:passed,syntheticRows:10000,guards:triggers,batch25Inserts:{beforeMs,afterMs},plans}));
} finally { await client.end(); }
