import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Client, Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

const connectionString = process.env.PROPOSAL_QA_DATABASE_URL;
const describeDatabase = connectionString ? describe : describe.skip;
const schema = `provider_binding_qa_${Date.now()}_${process.pid}`;
let admin: Client;
let pool: Pool;
let database: NodePgDatabase;

jest.unstable_mockModule('../models/db.js', () => ({
  db: new Proxy({}, {
    get(_target, key) {
      const value = database[key as keyof typeof database];
      return typeof value === 'function' ? value.bind(database) : value;
    },
  }),
}));
jest.unstable_mockModule('../services/integrations/MetaCapabilityRegistry.js', () => ({
  getMetaAppReviewPermissions: async () => ({}),
}));

const { inspectOfficialProviderBinding } = await import('../services/outreach/ProviderBindingService.js');

describeDatabase('official Resend binding on isolated PostgreSQL schema', () => {
  beforeAll(async () => {
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    database = drizzle(pool);
    await admin.query(`
      CREATE TABLE ${schema}.admin_api_credentials (
        id serial PRIMARY KEY,
        platform varchar(50) NOT NULL,
        api_key text NOT NULL,
        is_encrypted boolean NOT NULL DEFAULT false,
        is_active boolean NOT NULL DEFAULT true,
        validation_status varchar(20),
        last_validated_at timestamp,
        updated_at timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE ${schema}.resend_domains (
        id serial PRIMARY KEY,
        user_id integer NOT NULL,
        name varchar(255) NOT NULL,
        status varchar(50) NOT NULL,
        updated_at timestamp NOT NULL DEFAULT now()
      );
      INSERT INTO ${schema}.admin_api_credentials
        (id,platform,api_key,is_encrypted,is_active,validation_status,last_validated_at,updated_at)
      VALUES
        (10,'resend','encrypted-old',true,true,'valid',now()-interval '2 days',now()-interval '2 days'),
        (11,'resend','encrypted-new',true,true,'valid',now()-interval '1 day',now()-interval '1 day');
      INSERT INTO ${schema}.resend_domains(user_id,name,status)
      VALUES (1,'tenant.example','verified'),(2,'other.example','verified');
    `);
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('uses the newest verified credential for a new reviewed send', async () => {
    const result = await inspectOfficialProviderBinding(1, 'email', {
      providerVariant: 'resend',
      providerAccountId: 'tenant.example',
    });
    expect(result).toMatchObject({
      ready: true,
      credentialValuesExposed: false,
      binding: { credentialId: 11, providerAccountId: 'tenant.example', providerVariant: 'resend' },
    });
    expect(JSON.stringify(result)).not.toContain('encrypted-new');
  });

  it('revalidates the exact frozen credential during a resumed delivery', async () => {
    const result = await inspectOfficialProviderBinding(1, 'email', {
      providerVariant: 'resend',
      providerAccountId: 'tenant.example',
      credentialId: 10,
    });
    expect(result).toMatchObject({
      ready: true,
      missing: [],
      binding: { credentialId: 10, providerAccountId: 'tenant.example' },
    });
  });

  it('fails closed when the frozen credential or tenant domain is unavailable', async () => {
    const missingCredential = await inspectOfficialProviderBinding(1, 'email', {
      providerVariant: 'resend',
      providerAccountId: 'tenant.example',
      credentialId: 999,
    });
    expect(missingCredential).toMatchObject({ ready: false, missing: expect.arrayContaining(['operator_credential']) });

    const foreignDomain = await inspectOfficialProviderBinding(1, 'email', {
      providerVariant: 'resend',
      providerAccountId: 'other.example',
      credentialId: 10,
    });
    expect(foreignDomain).toMatchObject({ ready: false, missing: expect.arrayContaining(['verified_tenant_domain']) });

    await admin.query(`UPDATE ${schema}.admin_api_credentials SET is_active=false WHERE id=10`);
    const inactive = await inspectOfficialProviderBinding(1, 'email', {
      providerVariant: 'resend',
      providerAccountId: 'tenant.example',
      credentialId: 10,
    });
    expect(inactive).toMatchObject({ ready: false, missing: expect.arrayContaining(['operator_credential']) });
  });
});
