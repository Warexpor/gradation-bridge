/**
 * Directory listing for bridge/browse.
 * A workspace can contain node_modules-sized folders. Reading every name and
 * stat'ing every symlink on the WebSocket thread stalls ping and every other
 * session, so the result is capped.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const MAX_BROWSE_ENTRIES = 1000;

export interface BrowseEntry {
  name: string;
  dir: boolean;
}

export function listDirectory(
  dir: string,
  limit = MAX_BROWSE_ENTRIES,
): { entries: BrowseEntry[]; truncated: boolean } {
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : MAX_BROWSE_ENTRIES;
  const dirents = readdirSync(dir, { withFileTypes: true });
  const truncated = dirents.length > cap;
  const entries: BrowseEntry[] = [];
  for (const dent of dirents) {
    if (entries.length >= cap) break;
    let dirEntry = dent.isDirectory();
    // Match the previous stat() behaviour for a symlink to a directory.
    // Only symlinks are followed, and only up to the cap.
    if (dent.isSymbolicLink()) {
      try {
        dirEntry = statSync(join(dir, dent.name)).isDirectory();
      } catch {
        dirEntry = false;
      }
    }
    entries.push({ name: dent.name, dir: dirEntry });
  }
  return { entries, truncated };
}
