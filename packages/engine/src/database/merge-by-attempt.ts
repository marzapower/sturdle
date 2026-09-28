/**
 * Merges per-attempt entries (job steps or logs): entries of the incoming array replace only the
 * existing entries that share the same `attempt`, entries of other attempts are preserved as-is.
 * Legacy entries with no `attempt` (persisted before this field existed) are treated as attempt 1
 * for the purpose of this comparison.
 */
export function mergeByAttempt<T extends { attempt?: number }>(existing: T[], incoming: T[]): T[] {
  const incomingAttempts = new Set(incoming.map((entry) => entry.attempt ?? 1));
  const kept = existing.filter((entry) => !incomingAttempts.has(entry.attempt ?? 1));

  return [...kept, ...incoming];
}
