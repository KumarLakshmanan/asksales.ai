import { defineConfig } from "drizzle-kit";
import * as dotenv from 'dotenv';

dotenv.config();

const databaseUrl = process.env.DATABASE_URL || 
  `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME || process.env.DB_DATABASE}`;

if (!databaseUrl || databaseUrl.includes('undefined')) {
  throw new Error("Database configuration not found. Please set DATABASE_URL or DB_* variables in .env file");
}

export default defineConfig({
  out: "./migrations_drizzle",
  schema: "./models/allSchemas.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
  verbose: true,
  strict: true,
  // Exclude langgraph checkpoint tables - they are managed externally
  tablesFilter: ["!checkpoint*"],
});
