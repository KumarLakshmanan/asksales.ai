import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Request, Response } from 'express';

const local = process.env.HOTEL_CURRENCY_LOCAL_QA === '1' ? describe : describe.skip;
let pool: Pool;
const execute = async (query: SQL) => {
  const compiled = new PgDialect().sqlToQuery(query);
  return pool.query(compiled.sql, compiled.params);
};
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() } }));
const { getHotelSummary } = await import('../controllers/hotelAdminController.js');

local('Hotel revenue currency provenance in isolated PostgreSQL', () => {
  let admin: Pool;
  let schema: string;
  beforeAll(async () => {
    dotenv.config({ path: '.env', override: true, quiet: true });
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST || '')) throw new Error('Hotel QA requires local PostgreSQL');
    const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME,
      user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectionTimeoutMillis: 5000 };
    schema = `hotel_currency_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...connection, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ ...connection, max: 1, options: `-c search_path=${schema},pg_catalog` });
    await pool.query(`CREATE TABLE hotel_properties(id integer, user_id integer, currency text);
      CREATE TABLE room_types(id integer, hotel_id integer);
      CREATE TABLE bookings(id integer, user_id integer, status text, currency text, total_price numeric);
      INSERT INTO hotel_properties VALUES(12,42,'USD'); INSERT INTO room_types VALUES(1,12);`);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  async function summary() {
    const json = jest.fn();
    const res = { json, status: jest.fn() };
    res.status.mockReturnValue(res);
    await getHotelSummary({ user: { id: 42 } } as Request, res as unknown as Response);
    expect(res.status).not.toHaveBeenCalled();
    return json.mock.calls[0][0];
  }
  it('returns no invented revenue unit for a property with no bookings', async () => {
    expect(await summary()).toEqual({ totalRoomTypes: 1, totalBookings: 0, confirmedBookings: 0, revenueByCurrency: {} });
  });
  it('groups historical currencies and unknown provenance without converting or rewriting amounts', async () => {
    await pool.query(`INSERT INTO bookings VALUES(1,42,'confirmed','INR',125), (2,42,'confirmed',' USD ',10),
      (3,42,'confirmed',NULL,7), (4,42,'confirmed','',3), (5,42,'cancelled','USD',100), (6,99,'confirmed','EUR',500);`);
    const before = (await pool.query('SELECT * FROM bookings ORDER BY id')).rows;
    expect(await summary()).toEqual({ totalRoomTypes: 1, totalBookings: 5, confirmedBookings: 4,
      revenueByCurrency: { INR: 125, USD: 10, UNKNOWN: 10 } });
    expect((await pool.query('SELECT * FROM bookings ORDER BY id')).rows).toEqual(before);
  });
});
