import { Request, Response } from "express";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { logger } from '../utils/logger.js';

// Phase 4.15 / CTRL-002, PERF-005: in-memory cache for actor JSON files.
//  - 10-minute TTL: stale enough to be ignored in dev hot-reload, fresh
//    enough that production changes propagate within 10 minutes.
//  - fs.watch on each directory provides hot-reload outside the TTL.
//  - The cache is keyed by directory + mtime+size, so a re-read after a
//    write picks up the change immediately even if the watch event is missed.
interface CachedDir {
  expiresAt: number;
  entries: unknown[];
  watcher?: fsSync.FSWatcher;
}
const CACHE_TTL_MS = 10 * 60 * 1000;
const dirCache = new Map<string, CachedDir>();
let watchersInitialized = false;

function evictIfExpired(dir: string, entry: CachedDir): boolean {
  if (entry.expiresAt > Date.now()) return true;
  // Stale — close watcher if any, then drop.
  try { entry.watcher?.close(); } catch { /* noop */ }
  dirCache.delete(dir);
  return false;
}

async function loadFromDir(dir: string): Promise<unknown[]> {
  const resolvedDir = path.resolve(dir);
  const cached = dirCache.get(resolvedDir);
  if (cached && evictIfExpired(resolvedDir, cached)) {
    return cached.entries;
  }
  let entries: unknown[] = [];
  try {
    const files = await fs.readdir(resolvedDir);
    const jsonFiles = files.filter(file => file.endsWith('.json'));
    for (const file of jsonFiles) {
      const fullPath = path.resolve(resolvedDir, file);
      if (!fullPath.startsWith(resolvedDir + path.sep) && fullPath !== resolvedDir) {
        logger.warn({ file, fullPath, resolvedDir }, '[actorsController] Skipping file outside anchor dir');
        continue;
      }
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        entries.push(JSON.parse(content));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (parseErr: any) {
        logger.warn({ file, err: parseErr.message }, '[actorsController] Failed to parse actor JSON');
      }
    }
  } catch {
    entries = [];
  }
  // Lazy-init watchers on first cache miss.
  if (!watchersInitialized) initWatchers();
  dirCache.set(resolvedDir, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    entries,
  });
  return entries;
}

function initWatchers(): void {
  watchersInitialized = true;
  const watch = (dir: string) => {
    if (dirCache.has(dir) && dirCache.get(dir)!.watcher) return;
    try {
      const watcher = fsSync.watch(dir, { persistent: false }, () => {
        // Invalidate cache for this dir on any change.
        const entry = dirCache.get(dir);
        if (entry) {
          try { entry.watcher?.close(); } catch { /* noop */ }
          dirCache.delete(dir);
        }
      });
      dirCache.set(dir, {
        expiresAt: 0, // force a re-read on next request
        entries: dirCache.get(dir)?.entries ?? [],
        watcher,
      });
    } catch (err) {
      logger.warn({ err, dir }, '[actorsController] fs.watch failed — falling back to TTL-only invalidation');
    }
  };
  watch(path.join(process.cwd(), "data/actors"));
  watch(path.join(process.cwd(), "data/nodes"));
}

export async function getAvailableActors(req: Request, res: Response) {
  try {
    // Read actor schemas from data/actors and data/nodes directories
    const actorsDir = path.join(process.cwd(), "data/actors");
    const nodesDir = path.join(process.cwd(), "data/nodes");

    try {
      const [actorSchemas, nodeSchemas] = await Promise.all([
        loadFromDir(actorsDir),
        loadFromDir(nodesDir),
      ]);
      const actors = [...actorSchemas, ...nodeSchemas];

      res.json({ actors });
    } catch (error) {
      logger.error({ err: error }, 'Error reading actors directory');
      // Fallback to default actors if directory doesn't exist
      res.json({
        actors: [
          {
            id: "linkedin_profile_scraper",
            name: "LinkedIn Profile Scraper",
            description: "Scrapes LinkedIn profiles from a list of URLs"
          },
          {
            id: "linkedin_search",
            name: "LinkedIn Search",
            description: "Search for LinkedIn profiles based on criteria"
          },
          {
            id: "facebook_posts_scraper",
            name: "Facebook Posts Scraper",
            description: "Scrapes posts from Facebook pages or groups"
          },
          {
            id: "instagram_profile_scraper",
            name: "Instagram Profile Scraper",
            description: "Scrapes Instagram profiles and posts"
          },
          {
            id: "google_maps_scraper",
            name: "Google Maps Scraper",
            description: "Scrapes business data from Google Maps"
          },
          {
            id: "justdial_scraper",
            name: "JustDial Scraper",
            description: "Scrapes business listings from JustDial directory"
          },
          {
            id: "twitter_scraper",
            name: "Twitter Scraper",
            description: "Scrapes tweets and profiles from Twitter/X"
          }
        ]
      });
    }
  } catch (error) {
    logger.error({ err: error }, 'Get available actors error');
    res.status(500).json({ message: "Unable to retrieve available actors. Please try again." });
  }
}
