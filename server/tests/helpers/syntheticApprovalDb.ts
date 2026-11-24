/* eslint-disable @typescript-eslint/no-explicit-any */
import { createRequire } from 'node:module';
// Jest's older builtin-module list does not yet recognize node:sqlite.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { getTableColumns, getTableName, SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/** Disposable in-memory SQL adapter for approval control-flow tests. Executes
 * actual generated predicates and rollback; not a PostgreSQL/RLS substitute. */
export function syntheticApprovalDb(tables: any[]) {
  const sqlite = new DatabaseSync(':memory:');
  const dialect = new PgDialect();
  let transactionTail = Promise.resolve();
  let failInsert = false;
  const columns = (table: any) => getTableColumns(table) as Record<string, any>;
  const encode = (value: any) => value instanceof Date ? value.getTime() : typeof value === 'boolean' ? Number(value)
    : value && typeof value === 'object' ? JSON.stringify(value) : value ?? null;
  const compile = (value: SQL) => {
    const query = dialect.sqlToQuery(value);
    return { sql: query.sql.replace(/\$\d+/g, '?'), params: query.params.map(value =>
      typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : encode(value)) };
  };
  const decode = (table: any, raw: any) => Object.fromEntries(Object.entries(columns(table)).map(([key, column]) => {
    let value = raw[column.name];
    if (value != null && column.dataType === 'date') value = new Date(Number(value));
    else if (value != null && column.dataType === 'json') value = JSON.parse(value);
    else if (value != null && column.dataType === 'boolean') value = Boolean(value);
    return [key, value];
  }));
  for (const table of tables) {
    const definitions = Object.values(columns(table)).map(column => `"${column.name}" ${column.name === 'id'
      ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : ['number', 'date', 'boolean'].includes(column.dataType) ? 'INTEGER' : 'TEXT'}`);
    sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${definitions.join(', ')})`);
  }
  const adapter: any = {
    select: (projection?: any) => ({ from: (table: any) => {
      let condition: SQL | undefined;
      const chain: any = { where: (where: SQL) => { condition = where; return chain; }, for: () => chain,
        limit: async (limit: number) => {
          const query = condition ? compile(condition) : { sql: '1', params: [] };
          const rows = sqlite.prepare(`SELECT * FROM "${getTableName(table)}" WHERE ${query.sql} LIMIT ?`).all(...query.params, limit)
            .map(row => decode(table, row));
          return projection ? rows.map(row => Object.fromEntries(Object.keys(projection).map(key => [key, row[key]]))) : rows;
        } };
      return chain;
    } }),
    insert: (table: any) => ({ values: (data: any) => {
      const chain: any = { onConflictDoNothing: () => chain, returning: async () => {
        if (failInsert) { failInsert = false; throw new Error('SYNTHETIC_EXECUTION_INSERT_FAILURE'); }
        const fields = columns(table);
        const values = Object.entries({ businessProfileId: 9, ...data });
        const rows = sqlite.prepare(`INSERT INTO "${getTableName(table)}" (${values.map(([key]) => `"${fields[key].name}"`).join(', ')}) VALUES (${values.map(() => '?').join(', ')}) RETURNING *`)
          .all(...values.map(([, value]) => encode(value)));
        return rows.map(row => decode(table, row));
      } };
      return chain;
    } }),
    update: (table: any) => ({ set: (data: any) => ({ where: (where: SQL) => {
      const run = async () => {
        const params: any[] = [];
        const fields = columns(table);
        const assignments = Object.entries(data).map(([key, value]) => {
          if (value instanceof SQL) { const expression = compile(value); params.push(...expression.params); return `"${fields[key].name}" = ${expression.sql}`; }
          params.push(encode(value)); return `"${fields[key].name}" = ?`;
        });
        const query = compile(where); params.push(...query.params);
        return sqlite.prepare(`UPDATE "${getTableName(table)}" SET ${assignments.join(', ')} WHERE ${query.sql} RETURNING *`).all(...params).map(row => decode(table, row));
      };
      return { returning: run, then: (yes: any, no: any) => run().then(yes, no) };
    } }) }),
    transaction: (work: any) => {
      const pending = transactionTail.then(async () => {
        sqlite.exec('BEGIN');
        try { const result = await work(adapter); sqlite.exec('COMMIT'); return result; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      });
      transactionTail = pending.then(() => undefined, () => undefined);
      return pending;
    },
    failNextInsert: () => { failInsert = true; },
    rows: (table: any) => sqlite.prepare(`SELECT * FROM "${getTableName(table)}"`).all().map(row => decode(table, row)),
    close: () => sqlite.close(),
  };
  return adapter;
}
