const ISLAND_MUTATION_FACT_KEYS = [
  'desiredStateChanged',
  'registryChanged',
  'physicalChanged',
  'externalDrift',
  'incompleteRecovery',
] as const;

/** What an Island operation durably changed or left unresolved. */
export type IslandMutationFacts = Record<(typeof ISLAND_MUTATION_FACT_KEYS)[number], boolean>;

export type IslandMutationResult = IslandMutationFacts & { changed: boolean };

export function islandMutationFacts(
  facts: Partial<IslandMutationFacts> = {}
): IslandMutationResult {
  return mergeIslandMutationFacts(facts);
}

export function mergeIslandMutationFacts(
  ...facts: ReadonlyArray<Partial<IslandMutationFacts> | undefined>
): IslandMutationResult {
  const merged = Object.fromEntries(
    ISLAND_MUTATION_FACT_KEYS.map((key) => [key, facts.some((fact) => fact?.[key] === true)])
  ) as IslandMutationFacts;
  return {
    ...merged,
    changed: merged.desiredStateChanged || merged.registryChanged || merged.physicalChanged,
  };
}

/**
 * An Island failure that asserts its own mutation facts. Facts of wrapped
 * causes are not copied: {@link readIslandMutationFacts} merges the whole
 * error graph.
 */
export class IslandMutationError extends Error implements IslandMutationResult {
  readonly desiredStateChanged: boolean;
  readonly registryChanged: boolean;
  readonly physicalChanged: boolean;
  readonly externalDrift: boolean;
  readonly incompleteRecovery: boolean;
  readonly changed: boolean;

  constructor(message: string, facts: Partial<IslandMutationFacts>, options?: ErrorOptions) {
    super(message, options);
    const own = islandMutationFacts(facts);
    this.desiredStateChanged = own.desiredStateChanged;
    this.registryChanged = own.registryChanged;
    this.physicalChanged = own.physicalChanged;
    this.externalDrift = own.externalDrift;
    this.incompleteRecovery = own.incompleteRecovery;
    this.changed = own.changed;
  }
}

/** Breadth-first walk of an error and its `AggregateError.errors` and `cause` links. */
export function* islandErrorGraph(root: unknown): Generator<unknown> {
  const pending = [root];
  const visited = new Set<unknown>();

  while (pending.length > 0) {
    const candidate = pending.shift();
    if (candidate === undefined || visited.has(candidate)) continue;
    visited.add(candidate);
    yield candidate;

    if (candidate instanceof AggregateError) pending.push(...candidate.errors);
    if (candidate instanceof Error && candidate.cause !== undefined) pending.push(candidate.cause);
  }
}

/** Merge the facts asserted by an operation result or by any node of an error graph. */
export function readIslandMutationFacts(value: unknown): IslandMutationResult {
  const asserted: Partial<IslandMutationFacts>[] = [];
  for (const node of islandErrorGraph(value)) {
    if (typeof node === 'object' && node !== null) asserted.push(node);
  }
  return mergeIslandMutationFacts(...asserted);
}
