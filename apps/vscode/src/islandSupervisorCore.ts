export function didIslandMutationChange(error: unknown): boolean {
  const pending = [error];
  const visited = new Set<unknown>();

  while (pending.length > 0) {
    const candidate = pending.shift();
    if (candidate === undefined || visited.has(candidate)) continue;
    visited.add(candidate);

    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      'changed' in candidate &&
      candidate.changed === true
    ) {
      return true;
    }

    if (candidate instanceof AggregateError) {
      pending.push(...candidate.errors);
    }

    if (candidate instanceof Error && candidate.cause !== undefined) {
      pending.push(candidate.cause);
    }
  }

  return false;
}
