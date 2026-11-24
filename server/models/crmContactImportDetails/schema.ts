import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { crmContactImportsTable } from '../crmContactImports/schema';
import { crmContactsTable } from '../crmContacts/schema';

export const crmContactImportDetailsTable = pgTable('crm_contact_import_details', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  importId: integer('import_id').notNull().references(() => crmContactImportsTable.id, { onDelete: 'cascade' }),
  rowNumber: integer('row_number').notNull(),
  originalData: jsonb('original_data'),
  parsedData: jsonb('parsed_data'),
  mappedContactData: jsonb('mapped_contact_data'),
  status: varchar('status', { length: 50 }).notNull().default('pending'),
  errorMessage: text('error_message'),
  createdContactId: integer('created_contact_id').references(() => crmContactsTable.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  rowReceiptUq: uniqueIndex('crm_import_row_receipt_uq').on(table.importId, table.rowNumber),
  importIdIdx: index('idx_crm_contact_import_details_import_id').on(table.importId),
  statusIdx: index('idx_crm_contact_import_details_status').on(table.status),
}));
