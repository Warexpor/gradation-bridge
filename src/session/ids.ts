/** Session ids become directory names. Reject anything that can escape that folder. */
export function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id);
}

/** Newest first. Equal timestamps stay in sessionId order so pages do not reshuffle. */
export function compareRecentSession(
  a: { updatedAt: string; sessionId: string },
  b: { updatedAt: string; sessionId: string },
): number {
  const byTime = b.updatedAt.localeCompare(a.updatedAt);
  if (byTime !== 0) return byTime;
  return b.sessionId.localeCompare(a.sessionId);
}
