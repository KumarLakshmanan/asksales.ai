import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope, withSystemScope } from '../tenancy/businessContext.js';
import { withBillingScope } from '../tenancy/billingContext.js';
import { aiSettings } from '../models/aiSettings/schema.js';
import { assertBusinessScopeSchema } from '../tenancy/schemaGuard.js';

// The target must be a disposable, migrated database. Never infer the target
// from the application's environment or connect to a production database.
const database = process.env.BUSINESS_ISOLATION_TEST_DATABASE;
const socket = process.env.BUSINESS_ISOLATION_TEST_SOCKET;
const suite = database ? describe : describe.skip;
suite('business isolation through the real application PostgreSQL adapter', () => {
  let admin: Pool;
  let pool: Pool;
  let single: Pool;
  let userA: number, userB: number, north: number, south: number, other: number;
  let northThread: number, southThread: number, northTeam: number;
  const business = <T>(profile: number, work: () => T) => withBusinessScope({ userId: profile === other ? userB : userA, businessProfileId: profile }, work);

  beforeAll(async () => {
    if (!database?.startsWith('salesmarketing_business_isolation_qa_')) throw new Error('Use a dedicated business isolation QA database.');
    if (socket && !/^\/tmp\/salesmarketing-business-isolation-qa-[a-zA-Z0-9]+\/socket$/.test(socket)) {
      throw new Error('Use the exclusively owned socket from the disposable local QA runner.');
    }
    const config = { host: socket || '/tmp', database, connectionTimeoutMillis: 5000,
      ...(socket ? { port: 5432, user: 'postgres', password: '', ssl: false, options: '' } : {}) };
    admin = new Pool({ ...config, max: 1 });
    pool = createBusinessScopedPool(new Pool({ ...config, max: 2 }));
    single = createBusinessScopedPool(new Pool({ ...config, max: 1 }));
    const suffix = randomUUID();
    const users = await admin.query("INSERT INTO users(email,password,name) VALUES($1,'fixture','Isolation A'),($2,'fixture','Isolation B') RETURNING id", [`isolation-a-${suffix}@example.invalid`, `isolation-b-${suffix}@example.invalid`]);
    [userA,userB] = users.rows.map(row => row.id);
    const profiles = await admin.query("INSERT INTO company_settings(user_id,name,is_default) VALUES($1,'North',true),($1,'South',false),($2,'Other account',true) RETURNING id", [userA,userB]);
    [north,south,other] = profiles.rows.map(row => row.id);
    northThread = await business(north, async () => (await pool.query("INSERT INTO chat_threads(user_id,title) VALUES($1,'North campaign') RETURNING id", [userA])).rows[0].id);
    southThread = await business(south, async () => (await pool.query("INSERT INTO chat_threads(user_id,title) VALUES($1,'South campaign') RETURNING id", [userA])).rows[0].id);
    northTeam = await business(north, async () => (await pool.query("INSERT INTO support_teams(user_id,name) VALUES($1,'North team') RETURNING id", [userA])).rows[0].id);
  });
  afterAll(async () => { await pool?.end(); await single?.end(); await admin?.end(); });

  it('forces an unprivileged role and isolates lists, IDs, updates and deletes', async () => {
    await business(north, async () => {
      expect((await pool.query(`SELECT current_user AS role,rolsuper,rolbypassrls,rolcanlogin
        FROM pg_roles WHERE rolname=current_user`)).rows[0]).toEqual({
        role: 'salesmarketing_business_runtime', rolsuper: false, rolbypassrls: false, rolcanlogin: false,
      });
      expect((await pool.query('SELECT id FROM chat_threads WHERE user_id=$1', [userA])).rows).toEqual([{ id:northThread }]);
      expect((await pool.query('SELECT id FROM chat_threads WHERE id=$1', [southThread])).rowCount).toBe(0);
      expect((await pool.query("UPDATE chat_threads SET title='wrong' WHERE id=$1 RETURNING id", [southThread])).rowCount).toBe(0);
      expect((await pool.query('DELETE FROM chat_threads WHERE id=$1 RETURNING id', [southThread])).rowCount).toBe(0);
    });
    await business(other, async () => expect((await pool.query('SELECT id FROM chat_threads WHERE user_id=$1', [userA])).rowCount).toBe(0));
    expect((await pool.query('SELECT id FROM chat_threads')).rowCount).toBe(0);
    await expect(pool.query("INSERT INTO chat_threads(user_id,title) VALUES($1,'unscoped')", [userA])).rejects.toThrow();
  });

  it('supports independent settings and upserts through Drizzle and raw SQL', async () => {
    const db = drizzle(pool);
    for (const [profile, model] of [[north, 'north-model'], [south, 'south-model']] as const) {
      await business(profile, async () => {
        await db.insert(aiSettings).values({ userId:userA, aiModel:model })
          .onConflictDoUpdate({ target:[aiSettings.businessProfileId,aiSettings.userId], set:{ aiModel:model } });
        await pool.query('INSERT INTO ai_settings(user_id,ai_model) VALUES($1,$2) ON CONFLICT(business_profile_id,user_id) DO UPDATE SET ai_model=EXCLUDED.ai_model', [userA,model]);
        expect((await db.select().from(aiSettings).where(eq(aiSettings.userId,userA)))[0].aiModel).toBe(model);
      });
    }
  });

  it('rejects explicit profile overrides, wrong owners and cross-business parent references', async () => {
    await business(north, async () => {
      await expect(pool.query("INSERT INTO chat_threads(user_id,business_profile_id) VALUES($1,$2)", [userA,south])).rejects.toThrow();
      await expect(pool.query("INSERT INTO knowledge_documents(user_id,source_type,title) VALUES($1,'text','Wrong account')", [userB])).rejects.toThrow();
      await expect(pool.query("INSERT INTO content_assets(user_id,thread_id,type,title,content,channel,status) VALUES($1,$2,'text','Wrong parent','x','email','draft')", [userA,southThread])).rejects.toThrow();
      await expect(pool.query('UPDATE chat_threads SET business_profile_id=$1,business_id=$1 WHERE id=$2', [south,northThread])).rejects.toThrow();
      const row = (await pool.query("INSERT INTO content_assets(user_id,thread_id,type,title,content,channel,status) VALUES($1,$2,'text','Owned content','x','email','draft') RETURNING business_profile_id", [userA,northThread])).rows[0];
      expect(row.business_profile_id).toBe(north);
    });
  });

  it('keeps support trigger side effects and default teams in the selected business', async () => {
    await business(south, async () => {
      const southTeam = (await pool.query("INSERT INTO support_teams(user_id,name) VALUES($1,'South team') RETURNING id", [userA])).rows[0].id;
      const ticket = (await pool.query("INSERT INTO support_tickets(user_id,ticket_number,subject) VALUES($1,$2,'Business ticket') RETURNING team_id", [userA,`QA-${randomUUID()}`])).rows[0];
      expect(ticket.team_id).toBe(southTeam);
      expect(ticket.team_id).not.toBe(northTeam);
      await expect(pool.query("INSERT INTO support_tickets(user_id,team_id,ticket_number,subject) VALUES($1,$2,$3,'Wrong team')", [userA,northTeam,`QA-${randomUUID()}`])).rejects.toThrow();
    });
  });

  it('retains transaction ownership across async context changes and rollback', async () => {
    await business(north, async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await business(south, async () => expect((await client.query('SELECT id FROM chat_threads WHERE user_id=$1', [userA])).rows).toEqual([{ id:northThread }]));
        await client.query("INSERT INTO chat_threads(user_id,title) VALUES($1,'rolled back')", [userA]);
        await client.query('ROLLBACK');
      } finally { client.release(); }
      await drizzle(pool).transaction(async tx => {
        const rows = await tx.execute(sql`SELECT business_profile_id FROM chat_threads WHERE id=${northThread}`);
        expect(rows.rows[0].business_profile_id).toBe(north);
      });
    });
  });

  it('does not leak connection settings during concurrent pool reuse', async () => {
    await Promise.all(Array.from({length:24}, (_,index) => business(index%2 ? north : south, async () => {
      const wanted = index%2 ? north : south;
      const rows = await pool.query('SELECT id,business_profile_id FROM chat_threads WHERE user_id=$1', [userA]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].business_profile_id).toBe(wanted);
    })));
    expect((await pool.query('SELECT id FROM chat_threads')).rows).toEqual([]);
    expect((await withSystemScope('Isolation QA inventory', () => pool.query('SELECT id FROM chat_threads WHERE user_id=$1', [userA]))).rowCount).toBe(2);
  });

  it('rejects a foreign account paired with an otherwise valid profile', async () => {
    await withBusinessScope({ userId: userB, businessProfileId: north }, async () => {
      expect((await single.query('SELECT id FROM chat_threads')).rows).toEqual([]);
      await expect(single.query("INSERT INTO chat_threads(user_id,title) VALUES($1,'wrong owner')", [userB]))
        .rejects.toMatchObject({ code: '23514' });
    });
    await business(north, async () => {
      await expect(single.query('INSERT INTO content_assets(user_id,thread_id) VALUES($1,$2)', [userA,southThread]))
        .rejects.toMatchObject({ code: '23503' });
      await expect(single.query('UPDATE chat_threads SET business_profile_id=$1 WHERE id=$2', [south,northThread]))
        .rejects.toMatchObject({ code: '23514' });
    });
  });

  it('clears business, actor, billing and system settings on the same physical connection after errors', async () => {
    let pid: number;
    await withBillingScope({ organizationId: 7001, actorUserId: userB }, () =>
      withBusinessScope({ userId: userA, businessProfileId: north, actorUserId: userB, role: 'member' }, async () => {
        const state = (await single.query(`SELECT pg_backend_pid() AS pid,
          app_business_profile_id() AS profile,app_business_user_id() AS owner,
          current_setting('app.business_actor_user_id') AS actor,
          current_setting('app.billing_organization_id') AS payer,
          current_setting('app.billing_actor_user_id') AS billing_actor`)).rows[0];
        pid = state.pid;
        expect(state).toMatchObject({ profile: north, owner: userA, actor: String(userB), payer: '7001', billing_actor: String(userB) });
        await expect(single.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' });
      }));
    const state = (await single.query(`SELECT pg_backend_pid() AS pid,
      app_business_profile_id() AS profile,app_business_user_id() AS owner,app_business_system() AS system,
      current_setting('app.business_actor_user_id') AS actor,
      current_setting('app.billing_organization_id') AS payer,
      current_setting('app.billing_actor_user_id') AS billing_actor`)).rows[0];
    expect(state).toEqual({ pid: pid!, profile: null, owner: null, system: false, actor: '', payer: '', billing_actor: '' });
    expect((await single.query('SELECT id FROM chat_threads')).rows).toEqual([]);
    await withSystemScope('QA one-connection administrative read', () => single.query('SELECT id FROM chat_threads'));
    expect((await single.query('SELECT app_business_system() AS system')).rows[0].system).toBe(false);
  });

  it('keeps savepoint rollback and attempted ambient system elevation inside the captured business', async () => {
    const client = await business(north, () => single.connect());
    try {
      await client.query('BEGIN');
      await client.query('SAVEPOINT before_error');
      await expect(client.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' });
      await client.query('ROLLBACK TO SAVEPOINT before_error');
      await withSystemScope('QA cannot retarget an open business transaction', async () => {
        expect((await client.query('SELECT app_business_system() AS system')).rows[0].system).toBe(false);
        expect((await client.query('SELECT id FROM chat_threads WHERE id=$1', [southThread])).rows).toEqual([]);
      });
      expect((await client.query('SELECT id FROM chat_threads WHERE id=$1', [northThread])).rowCount).toBe(1);
      await client.query('COMMIT');
    } finally { client.release(); }
    expect((await single.query('SELECT id FROM chat_threads')).rows).toEqual([]);
  });

  it('discards an abandoned transaction and rolls back its writes before the next tenant checkout', async () => {
    const client = await business(north, () => single.connect());
    const title = `abandoned-${randomUUID()}`;
    let abandonedPid: number;
    try {
      await client.query('BEGIN');
      abandonedPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await client.query('INSERT INTO chat_threads(user_id,title) VALUES($1,$2)', [userA,title]);
    } finally { client.release(); }
    await business(south, async () => {
      const state = (await single.query('SELECT pg_backend_pid() AS pid,app_business_profile_id() AS profile')).rows[0];
      expect(state.pid).not.toBe(abandonedPid!);
      expect(state.profile).toBe(south);
    });
    expect((await admin.query('SELECT id FROM chat_threads WHERE title=$1', [title])).rows).toEqual([]);
    expect((await single.query('SELECT id FROM chat_threads')).rows).toEqual([]);
  });

  it('keeps unrouted webhook telemetry administrative and pixel events business scoped', async () => {
    const unrouted = await withSystemScope('QA unrouted callback', () => pool.query("INSERT INTO webhook_events(platform,event_type) VALUES('instagram','signature_rejected') RETURNING id"));
    const id = unrouted.rows[0].id;
    await business(north, async () => {
      expect((await pool.query('SELECT id FROM webhook_events WHERE id=$1', [id])).rowCount).toBe(0);
      const own = await pool.query("INSERT INTO webhook_events(platform,user_id) VALUES('instagram',$1) RETURNING business_profile_id", [userA]);
      expect(own.rows[0].business_profile_id).toBe(north);
      await pool.query("INSERT INTO pixel_events(event_type,user_id,timestamp) VALUES('page_view',$1,now())", [userA]);
    });
    await business(south, async () => expect((await pool.query('SELECT id FROM pixel_events WHERE user_id=$1', [userA])).rowCount).toBe(0));
    await expect(pool.query("INSERT INTO webhook_events(platform) VALUES('unscoped')")).rejects.toThrow();
    await expect(withSystemScope('QA rejects ambiguous ownership', () => pool.query("INSERT INTO webhook_events(platform,user_id) VALUES('unrouted',$1)", [userA]))).rejects.toThrow();
  });

  it('enforces every classified table and removes privileged business triggers', async () => {
    await assertBusinessScopeSchema(admin);
    const unprotected = await admin.query(`SELECT m.table_name FROM business_scope_tables m JOIN pg_class c ON c.oid=('public.'||m.table_name)::regclass
      WHERE NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='business_isolation')`);
    expect(unprotected.rows).toEqual([]);
    const privileged = await admin.query(`SELECT DISTINCT p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      JOIN business_scope_tables m ON t.tgrelid=('public.'||m.table_name)::regclass WHERE NOT t.tgisinternal AND p.prosecdef`);
    expect(privileged.rows).toEqual([]);
  });

  it('allows approved global templates and isolates editable copies', async () => {
    const templates = await withSystemScope('Create QA global template', async () => {
      const approved=(await pool.query("INSERT INTO content_templates(name,type,content,is_predefined,is_approved,user_id) VALUES('Published fixture','email','Approved',TRUE,TRUE,NULL) RETURNING id")).rows[0].id;
      const draft=(await pool.query("INSERT INTO content_templates(name,type,content,is_predefined,is_approved,user_id) VALUES('Draft fixture','email','Draft',TRUE,FALSE,NULL) RETURNING id")).rows[0].id;
      await pool.query("INSERT INTO content_template_versions(template_id,user_id,version,snapshot) VALUES($1,NULL,1,'{\"isApproved\":true}'),($1,NULL,2,'{\"isApproved\":false}')", [approved]);
      return {approved,draft};
    });
    await business(south, async () => {
      expect((await pool.query('SELECT id FROM content_templates WHERE id=ANY($1::integer[])', [[templates.approved,templates.draft]])).rows).toEqual([{id:templates.approved}]);
      expect((await pool.query('SELECT version FROM content_template_versions WHERE template_id=$1', [templates.approved])).rows).toEqual([{version:1}]);
      expect((await pool.query("UPDATE content_templates SET content='unauthorized' WHERE id=$1 RETURNING id", [templates.approved])).rowCount).toBe(0);
      const copy=(await pool.query("INSERT INTO content_templates(user_id,business_profile_id,name,type,content) VALUES($1,NULL,'My copy','email','Owned') RETURNING business_profile_id", [userA])).rows[0];
      expect(copy.business_profile_id).toBe(south);
    });
  });

  it('denies future unclassified tables and refuses application startup', async () => {
    await admin.query('CREATE TABLE business_isolation_future_fixture(user_id integer,business_profile_id integer)');
    try {
      await expect(assertBusinessScopeSchema(admin)).rejects.toThrow('business_isolation_future_fixture (unclassified table)');
      await expect(business(north, () => pool.query('SELECT * FROM business_isolation_future_fixture'))).rejects.toThrow('permission denied');
    } finally { await admin.query('DROP TABLE business_isolation_future_fixture'); }
    await assertBusinessScopeSchema(admin);
  });
});
