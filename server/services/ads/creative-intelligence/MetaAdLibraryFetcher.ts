import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { logger } from "../../../utils/logger.js";

const run = promisify(execFile);

export function metaAdLibraryFetcher(): "playwright" | "scrapling" {
  const provider = process.env.META_AD_LIBRARY_FETCHER?.trim().toLowerCase() || "scrapling";
  if (provider !== "playwright" && provider !== "scrapling") {
    throw new Error("META_AD_LIBRARY_FETCHER must be playwright or scrapling");
  }
  return provider;
}

// Resolve in both source execution and the single-file esbuild production bundle.
export function scraplingRuntime() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const roots = [process.cwd(), resolve(process.cwd(), "server"), resolve(moduleDir, "../../.."), resolve(moduleDir, "..")];
  const root = roots.find((path) => existsSync(resolve(path, "scripts/meta_ad_library_scrapling.py")));
  if (!root) throw new Error("Scrapling worker script is missing from the server deployment");
  const venvPython = resolve(root, ".venv-scrapling/bin/python");
  return {
    script: resolve(root, "scripts/meta_ad_library_scrapling.py"),
    python: process.env.META_AD_LIBRARY_PYTHON?.trim() || (existsSync(venvPython) ? venvPython : "python3"),
  };
}

const resultSchema = z.object({
  status: z.number().int().nullable(),
  text: z.string().max(2_000_000),
  regions: z.array(z.string().max(500_000)).max(20),
  screenshotPath: z.string().nullable(),
  error: z.enum(["dependency_missing", "fetch_failed"]).nullable(),
});

export async function fetchWithScrapling(url: string, action: "search" | "details") {
  const runtime = scraplingRuntime();
  logger.info({ provider: "scrapling", action, python: runtime.python }, "[CreativeIntelligence] Starting Scrapling worker");
  // No shell: the public URL is one literal argument, never executable input.
  const { stdout } = await run(runtime.python, [runtime.script, action, url], {
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
    killSignal: "SIGKILL",
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  return resultSchema.parse(JSON.parse(stdout));
}
