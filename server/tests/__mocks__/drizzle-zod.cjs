"use strict";
// Stub for drizzle-zod in Jest test environment.
// drizzle-zod's ESM build imports { Column } from 'drizzle-orm' which
// Jest's vm-modules ESM resolver can't handle (export* barrel re-exports).
// Schema shapes are never evaluated in unit tests — controllers are mocked
// at the DB level so Zod validation is never triggered.
const noOp = () => ({});
module.exports = {
  createInsertSchema: noOp,
  createSelectSchema: noOp,
  createUpdateSchema: noOp,
  createSchemaFactory: () => ({ createInsertSchema: noOp, createSelectSchema: noOp, createUpdateSchema: noOp }),
};
