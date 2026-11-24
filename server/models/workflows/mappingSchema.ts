import { pgTable, serial, text, integer, timestamp, jsonb, varchar, boolean } from "drizzle-orm/pg-core";

export const connectionMappings = pgTable("connection_mappings", {
  id: serial("id").primaryKey(),
  workflowId: integer("workflow_id").notNull(),
  sourceNodeId: text("source_node_id").notNull(),
  targetNodeId: text("target_node_id").notNull(),
  mappings: jsonb("mappings").notNull(),
  arrayIterationConfig: jsonb("array_iteration_config"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const fieldMappings = pgTable("field_mappings", {
  id: serial("id").primaryKey(),
  connectionMappingId: integer("connection_mapping_id").notNull(),
  sourceFieldPath: text("source_field_path").notNull(),
  targetFieldPath: text("target_field_path").notNull(),
  transformationType: varchar("transformation_type", { length: 50 }).default("direct"),
  transformationLogic: text("transformation_logic"),
  errorStrategy: varchar("error_strategy", { length: 20 }).default("skip"),
  defaultValue: jsonb("default_value"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const arrayIterationConfigs = pgTable("array_iteration_configs", {
  id: serial("id").primaryKey(),
  connectionMappingId: integer("connection_mapping_id").notNull(),
  sourceArrayPath: text("source_array_path").notNull(),
  iterationMode: varchar("iteration_mode", { length: 50 }).default("sequential"),
  batchSize: integer("batch_size"),
  itemReferenceVariable: text("item_reference_variable").default("_current_item"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const dbSaveMappings = pgTable("db_save_mappings", {
  id: serial("id").primaryKey(),
  workflowId: integer("workflow_id").notNull(),
  dbSaveNodeId: text("db_save_node_id").notNull(),
  databaseTable: text("database_table").notNull(),
  fieldMappings: jsonb("field_mappings").notNull(),
  batchInsert: boolean("batch_insert").default(false),
  onConflict: varchar("on_conflict", { length: 50 }).default("skip"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// TypeScript types
export type ConnectionMapping = typeof connectionMappings.$inferSelect;
export type ArrayIterationConfig = typeof arrayIterationConfigs.$inferSelect;

// Domain models for mapping logic
export interface FieldMappingConfig {
  id?: string;
  sourceFieldPath: string;
  targetFieldPath: string;
  transformationType: "direct" | "expression" | "script";
  transformationLogic?: string;
  errorStrategy: "skip" | "default" | "halt";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultValue?: any;
}

export interface ArrayIterationConfigDomain {
  sourceArrayPath: string;
  iterationMode: "sequential" | "parallel" | "batch";
  batchSize?: number;
  itemReferenceVariable: string;
}

