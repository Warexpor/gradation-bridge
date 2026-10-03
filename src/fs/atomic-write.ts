/**
 * Replace a private catalog file without following a symlink.
 *
 * `writeFileSync(path)` follows a symlink planted on the temp file or the
 * destination, so the bytes can land outside the directory that owns the
 * catalog. The temp file is created with `O_EXCL|O_NOFOLLOW`. An existing
 * destination is opened with `O_NOFOLLOW` and a symlink is refused instead
 * of being replaced or followed.
 */

import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export function privateWriteTempPath(dest: string): string {
  return join(dirname(dest), `.${basename(dest)}.${process.pid}.tmp`);
}

function symlinkError(): Error {
  return new Error("refusing to write through a symlink");
}

function lstatOrMissing(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Fail if `path` is a symlink. Missing paths are fine. */
function assertNotSymlink(path: string): void {
  const info = lstatOrMissing(path);
  if (info?.isSymbolicLink()) throw symlinkError();
}

/**
 * A destination we may replace: absent, or a regular file we can open
 * without following a final-component symlink.
 */
function assertReplaceableDest(path: string): void {
  const info = lstatOrMissing(path);
  if (!info) return;
  if (info.isSymbolicLink()) throw symlinkError();
  if (!info.isFile()) throw new Error("refusing to write through a non-regular file");
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw symlinkError();
    throw e;
  }
  closeSync(fd);
}

function openTempNoFollow(tmp: string): number {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
  try {
    return openSync(tmp, flags, 0o600);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw symlinkError();
    if (code === "EEXIST" && lstatOrMissing(tmp)?.isSymbolicLink()) throw symlinkError();
    throw e;
  }
}

/** Write `content` to `dest` (mode 0o600). Refuses a symlink at `dest` or the temp path. */
export function writePrivateNoFollow(dest: string, content: string): void {
  assertReplaceableDest(dest);
  const tmp = privateWriteTempPath(dest);
  assertNotSymlink(tmp);
  const leftover = lstatOrMissing(tmp);
  if (leftover && !leftover.isFile()) {
    throw new Error("refusing to write through a non-regular file");
  }
  if (leftover?.isFile()) unlinkSync(tmp);

  const fd = openTempNoFollow(tmp);
  try {
    writeFileSync(fd, content);
  } catch (e) {
    closeSync(fd);
    unlinkSync(tmp);
    throw e;
  }
  closeSync(fd);

  try {
    assertReplaceableDest(dest);
    renameSync(tmp, dest);
  } catch (e) {
    const info = lstatOrMissing(tmp);
    if (info?.isFile()) {
      try {
        unlinkSync(tmp);
      } catch {
        // The temp file is already gone, or a later cleanup can remove it.
      }
    }
    throw e;
  }
}
