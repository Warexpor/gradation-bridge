/**
 * Bounded text reads and writes for ACP fs/* .
 * A harness must not be able to pull an unbounded file into the bridge.
 */

import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";

export const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;
/** How far a line/limit read may scan into a file that is over the full-read cap. */
export const MAX_TEXT_SCAN_BYTES = 32 * 1024 * 1024;

function coded(message: string, code = -32602): Error {
  return Object.assign(new Error(message), { code });
}

export function assertWritableContent(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_TEXT_FILE_BYTES) {
    throw coded(`content exceeds ${MAX_TEXT_FILE_BYTES} byte write limit`);
  }
}

function openReadNoFollow(path: string): number {
  try {
    return openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") {
      throw coded("refusing to read through a symlink", -32003);
    }
    throw e;
  }
}

export function readTextFileWindow(
  path: string,
  opts?: { line?: number; limit?: number },
): string {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw coded("refusing to read through a symlink", -32003);
  if (!st.isFile()) throw coded("path is not a file");
  const startLine = opts?.line != null ? Math.max(1, Math.floor(opts.line)) : undefined;
  const limit = opts?.limit != null ? Math.max(0, Math.floor(opts.limit)) : undefined;
  if (limit === 0) return "";
  const windowed = startLine != null || limit != null;
  if (!windowed) {
    if (st.size > MAX_TEXT_FILE_BYTES) {
      throw coded(`file exceeds ${MAX_TEXT_FILE_BYTES} byte read limit`);
    }
    return readFileNoFollow(path);
  }
  if (st.size <= MAX_TEXT_FILE_BYTES) {
    return sliceLines(readFileNoFollow(path), startLine ?? 1, limit, false);
  }
  const prefixOnly = st.size > MAX_TEXT_SCAN_BYTES;
  const content = readPrefix(path, Math.min(Number(st.size), MAX_TEXT_SCAN_BYTES));
  return sliceLines(content, startLine ?? 1, limit, prefixOnly);
}

function sliceLines(content: string, startLine: number, limit: number | undefined, prefixOnly: boolean): string {
  const lines = content.split("\n");
  const start = Math.max(0, startLine - 1);
  if (prefixOnly && start >= lines.length) {
    throw coded("file read window exceeded scan limit");
  }
  const end = limit != null ? start + limit : lines.length;
  return lines.slice(start, end).join("\n");
}

function readFileNoFollow(path: string): string {
  const fd = openReadNoFollow(path);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function readPrefix(path: string, maxBytes: number): string {
  const fd = openReadNoFollow(path);
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, trimIncompleteUtf8(buf, n)).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Drop a split UTF-8 sequence at the end of a byte prefix. Complete characters stay. */
export function trimIncompleteUtf8(buf: Buffer, n: number): number {
  if (n <= 0) return 0;
  let i = n - 1;
  let cont = 0;
  while (i >= 0 && cont < 3 && (buf[i]! & 0xc0) === 0x80) {
    cont++;
    i--;
  }
  if (i < 0 || (buf[i]! & 0xc0) !== 0xc0) {
    return (buf[n - 1]! & 0xc0) === 0x80 ? n - cont : n;
  }
  const lead = buf[i]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
  if (cont + 1 < need) return i;
  return n;
}

/**
 * Write `content` to the real path. `O_NOFOLLOW` refuses a last-component
 * symlink swapped in after the sandbox check.
 */
export function writeTextNoFollow(path: string, content: string): void {
  assertWritableContent(content);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = openSync(path, flags, 0o666);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") {
      throw coded("refusing to write through a symlink", -32003);
    }
    throw e;
  }
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

export function assertNotDirectory(path: string): void {
  if (existsSync(path) && statSync(path).isDirectory()) {
    throw coded("path is a directory");
  }
}
