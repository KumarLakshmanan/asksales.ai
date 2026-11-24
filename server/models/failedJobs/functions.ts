import { db } from "../db.js";
import { failedJobsTable, type NewFailedJob, type FailedJob } from "./schema.js";

export async function insertFailedJob(input: NewFailedJob): Promise<FailedJob> {
  const [row] = await db.insert(failedJobsTable).values(input).returning();
  return row;
}

