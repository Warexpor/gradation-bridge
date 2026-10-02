/**
 * Directory listing for bridge/browse.
 * A workspace can contain node_modules-sized folders. Reading every name and
 * stat'ing every symlink on the WebSocket thread stalls ping and every other
 * session, so the result is capped. Iteration stops after the cap instead of
 * loading the whole directory into memory first.
 */

import { opendirSync, statSync } from "node:fs";
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
  const entries: BrowseEntry[] = [];
  let truncated = false;
  const handle = opendirSync(dir);
  try {
    // Read one past the cap so truncation is known without scanning the rest.
    while (entries.length <= cap) {
      const dent = handle.readSync();
      if (dent === null) break;
      if (entries.length >= cap) {
        truncated = true;
        break;
      }
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
  } finally {
    handle.closeSync();
  }
  return { entries, truncated };
}
