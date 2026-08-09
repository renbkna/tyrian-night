export type IslandMutationFacts = {
  desiredStateChanged: boolean;
  registryChanged: boolean;
  physicalChanged: boolean;
  externalDrift: boolean;
  incompleteRecovery: boolean;
};

export function islandMutationFacts(
  facts: Partial<IslandMutationFacts> = {}
): IslandMutationFacts & { changed: boolean } {
  const result: IslandMutationFacts = {
    desiredStateChanged: facts.desiredStateChanged ?? false,
    registryChanged: facts.registryChanged ?? false,
    physicalChanged: facts.physicalChanged ?? false,
    externalDrift: facts.externalDrift ?? false,
    incompleteRecovery: facts.incompleteRecovery ?? false,
  };

  return {
    ...result,
    changed: result.desiredStateChanged || result.registryChanged || result.physicalChanged,
  };
}

export function mergeIslandMutationFacts(
  ...facts: ReadonlyArray<Partial<IslandMutationFacts> | undefined>
): IslandMutationFacts & { changed: boolean } {
  return islandMutationFacts({
    desiredStateChanged: facts.some((fact) => fact?.desiredStateChanged === true),
    registryChanged: facts.some((fact) => fact?.registryChanged === true),
    physicalChanged: facts.some((fact) => fact?.physicalChanged === true),
    externalDrift: facts.some((fact) => fact?.externalDrift === true),
    incompleteRecovery: facts.some((fact) => fact?.incompleteRecovery === true),
  });
}

export function readIslandMutationFacts(
  value: unknown
): IslandMutationFacts & { changed: boolean } {
  const pending = [value];
  const visited = new Set<unknown>();
  const collected: Partial<IslandMutationFacts>[] = [];

  while (pending.length > 0) {
    const candidate = pending.shift();
    if (candidate === undefined || visited.has(candidate)) continue;
    visited.add(candidate);

    if (typeof candidate === 'object' && candidate !== null) {
      collected.push({
        desiredStateChanged:
          'desiredStateChanged' in candidate && candidate.desiredStateChanged === true,
        registryChanged: 'registryChanged' in candidate && candidate.registryChanged === true,
        physicalChanged: 'physicalChanged' in candidate && candidate.physicalChanged === true,
        externalDrift: 'externalDrift' in candidate && candidate.externalDrift === true,
        incompleteRecovery:
          'incompleteRecovery' in candidate && candidate.incompleteRecovery === true,
      });
    }

    if (candidate instanceof AggregateError) {
      pending.push(...candidate.errors);
    }

    if (candidate instanceof Error && candidate.cause !== undefined) {
      pending.push(candidate.cause);
    }
  }

  return mergeIslandMutationFacts(...collected);
}
