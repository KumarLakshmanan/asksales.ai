import { pgTable, serial, text, varchar, timestamp, integer } from "drizzle-orm/pg-core";
import { companySettings } from "../companySettings/schema";

export const knowledgeBaseTable = pgTable("knowledge_base", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  businessProfileId: integer("business_profile_id").references(() => companySettings.id, { onDelete: "set null" }),
  title: varchar("title", { length: 255 }).notNull(),
  description: varchar("description", { length: 500 }),
  content: text("content"), // For document type - not required since Q&A uses question/answer
  type: varchar("type", { length: 50 }).notNull().default("document"), // document, file, qa, url
  processingStatus: varchar("processing_status", { length: 20 }).notNull().default("completed"), // queued, processing, completed, failed
  extractionStatus: varchar("extraction_status", { length: 20 }).notNull().default("completed"),
  indexingStatus: varchar("indexing_status", { length: 20 }).notNull().default("completed"),
  fileName: varchar("file_name", { length: 255 }), // Original file name for uploaded files
  fileType: varchar("file_type", { length: 100 }), // MIME type for files
  fileSize: integer("file_size"), // File size in bytes
  question: text("question"), // For Q&A entries
  answer: text("answer"), // For Q&A entries
  sourceUrl: varchar("source_url", { length: 2048 }), // For URL-type entries - the original URL
  creationRequestKey: varchar('creation_request_key', { length: 100 }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type KnowledgeBaseEntry = typeof knowledgeBaseTable.$inferSelect;
export type InsertKnowledgeBaseEntry = typeof knowledgeBaseTable.$inferInsert;
