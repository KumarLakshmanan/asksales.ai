import { pgTable, serial, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

export const failedJobsTable = pgTable(
  "failed_jobs",
  {
    id: serial("id").primaryKey(),
    queue: text("queue").notNull(),
    jobId: text("job_id"),
    payload: jsonb("payload"),
    error: text("error"),
    stack: text("stack"),
    failedAt: timestamp("failed_at").defaultNow().notNull(),
  },
  (table) => ({
    queueFailedAtIdx: index("failed_jobs_queue_failed_at_idx").on(table.queue, table.failedAt),
    failedAtIdx: index("failed_jobs_failed_at_idx").on(table.failedAt),
  })
);

export type FailedJob = typeof failedJobsTable.$inferSelect;
export type NewFailedJob = typeof failedJobsTable.$inferInsert;
