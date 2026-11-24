import { integer } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Ownership is filled and validated by the database for ORM and raw inserts. */
export const businessProfileColumn = () => integer('business_profile_id').default(sql`app_business_profile_id()`);
