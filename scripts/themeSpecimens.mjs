// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadThemeDefinitionContext } from './themeDefinition.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @typedef {Record<string, any>} JsonObject */
/**
 * @typedef {{ role?: string; text: string }} SpecimenPart
 * @typedef {{ context: string; language: string; parts: SpecimenPart[]; provenance: { kind: 'authored-representative'; revision: number; sha256: string }; purpose: string; source: string }} ThemeSpecimen
 * @typedef {{ requiredContexts: string[]; requiredLanguages: string[]; requiredPairs: Array<[string, string]>; requiredRoles: string[]; specimens: string[] }} ThemeSpecimenSet
 * @typedef {{ extraction: { neighborhoodTokenRadius: number }; schemaVersion: 2; sets: Record<string, ThemeSpecimenSet>; specimens: Record<string, ThemeSpecimen> }} ThemeSpecimenContract
 */

export const THEME_SPECIMENS_PATH = path.join(ROOT, 'source', 'themeSpecimens.json');

/**
 * @param {string} [specimenPath]
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} [definition]
 * @returns {ThemeSpecimenContract}
 */
export function readThemeSpecimens(
  specimenPath = THEME_SPECIMENS_PATH,
  definition = loadThemeDefinitionContext(path.resolve(path.dirname(specimenPath), '..'))
) {
  return validateThemeSpecimens(JSON.parse(fs.readFileSync(specimenPath, 'utf8')), definition);
}

/**
 * Validates authored semantic spans and verifies that their concatenated source
 * still matches the reviewed content hash. Counts and neighborhoods are never input.
 * @param {unknown} value
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} [definition]
 * @returns {ThemeSpecimenContract}
 */
export function validateThemeSpecimens(value, definition = loadThemeDefinitionContext(ROOT)) {
  const contract = requireObject(value, 'Theme specimen contract');
  requireFields(
    contract,
    ['extraction', 'schemaVersion', 'sets', 'specimens'],
    'Theme specimen contract'
  );
  if (contract.schemaVersion !== 2) {
    throw new Error('Invalid theme specimen contract: schemaVersion must be 2.');
  }

  const extraction = requireObject(contract.extraction, 'Theme specimen extraction');
  requireFields(extraction, ['neighborhoodTokenRadius'], 'Theme specimen extraction');
  const neighborhoodTokenRadius = requirePositiveInteger(
    extraction.neighborhoodTokenRadius,
    'neighborhoodTokenRadius'
  );
  if (neighborhoodTokenRadius > 8) {
    throw new Error('Invalid theme specimen contract: neighborhoodTokenRadius exceeds 8.');
  }

  const specimenValues = requireObject(contract.specimens, 'Theme specimens');
  if (Object.keys(specimenValues).length === 0) {
    throw new Error('Invalid theme specimen contract: at least one specimen is required.');
  }
  /** @type {Record<string, ThemeSpecimen>} */
  const specimens = {};
  for (const [specimenId, specimenValue] of Object.entries(specimenValues)) {
    requireId(specimenId, 'specimen');
    const specimen = requireObject(specimenValue, `Theme specimen '${specimenId}'`);
    requireFields(
      specimen,
      ['context', 'language', 'parts', 'provenance', 'purpose'],
      `Theme specimen '${specimenId}'`
    );
    const context = requireContractId(specimen.context, `${specimenId}/context`);
    const language = requireText(specimen.language, `${specimenId}/language`);
    const purpose = requireText(specimen.purpose, `${specimenId}/purpose`);
    if (!Array.isArray(specimen.parts) || specimen.parts.length === 0) {
      throw new Error(`Invalid theme specimen contract: ${specimenId}/parts must be non-empty.`);
    }
    /** @type {SpecimenPart[]} */
    const parts = specimen.parts.map((partValue, index) => {
      const part = requireObject(partValue, `${specimenId}/parts/${index}`);
      const fields = Object.hasOwn(part, 'role') ? ['role', 'text'] : ['text'];
      requireFields(part, fields, `${specimenId}/parts/${index}`);
      const text = requireText(part.text, `${specimenId}/parts/${index}/text`);
      if (!Object.hasOwn(part, 'role')) {
        if (/\S/u.test(text)) {
          throw new Error(
            `Invalid theme specimen contract: ${specimenId}/parts/${index} leaves visible source unclassified.`
          );
        }
        return { text };
      }
      const role = requireKnownRole(part.role, definition, `${specimenId}/parts/${index}`);
      if (/\r|\n/u.test(text)) {
        throw new Error(
          `Invalid theme specimen contract: ${specimenId}/parts/${index} semantic text crosses a line.`
        );
      }
      if (visibleGlyphs(text) === 0) {
        throw new Error(
          `Invalid theme specimen contract: ${specimenId}/parts/${index} has no visible glyphs.`
        );
      }
      return { role, text };
    });
    for (let index = 1; index < parts.length; index += 1) {
      if (parts[index - 1].role && parts[index - 1].role === parts[index].role) {
        throw new Error(
          `Invalid theme specimen contract: ${specimenId}/parts/${index} duplicates an adjacent semantic span.`
        );
      }
    }
    const source = parts.map(({ text }) => text).join('');
    if (source.trim().length === 0) {
      throw new Error(`Invalid theme specimen contract: ${specimenId} has empty source.`);
    }
    const provenance = requireObject(specimen.provenance, `${specimenId}/provenance`);
    requireFields(provenance, ['kind', 'revision', 'sha256'], `${specimenId}/provenance`);
    if (provenance.kind !== 'authored-representative') {
      throw new Error(
        `Invalid theme specimen contract: ${specimenId} has invalid provenance kind.`
      );
    }
    const revision = requirePositiveInteger(provenance.revision, `${specimenId}/revision`);
    if (typeof provenance.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(provenance.sha256)) {
      throw new Error(`Invalid theme specimen contract: ${specimenId} has invalid sha256.`);
    }
    const actualHash = sha256(source);
    if (actualHash !== provenance.sha256) {
      throw new Error(
        `Invalid theme specimen contract: ${specimenId} content hash is ${actualHash}, expected ${provenance.sha256}.`
      );
    }
    specimens[specimenId] = {
      context,
      language,
      parts,
      provenance: { kind: 'authored-representative', revision, sha256: provenance.sha256 },
      purpose,
      source,
    };
  }

  const setValues = requireObject(contract.sets, 'Theme specimen sets');
  if (Object.keys(setValues).length === 0) {
    throw new Error('Invalid theme specimen contract: at least one specimen set is required.');
  }
  /** @type {Record<string, ThemeSpecimenSet>} */
  const sets = {};
  const usedSpecimens = new Set();
  for (const [setId, setValue] of Object.entries(setValues)) {
    requireId(setId, 'specimen set');
    const set = requireObject(setValue, `Theme specimen set '${setId}'`);
    requireFields(
      set,
      ['requiredContexts', 'requiredLanguages', 'requiredPairs', 'requiredRoles', 'specimens'],
      `Theme specimen set '${setId}'`
    );
    const specimenIds = requireUniqueStrings(set.specimens, `${setId}/specimens`);
    for (const specimenId of specimenIds) {
      if (!Object.hasOwn(specimens, specimenId)) {
        throw new Error(
          `Invalid theme specimen contract: set '${setId}' references unknown specimen '${specimenId}'.`
        );
      }
      usedSpecimens.add(specimenId);
    }
    const requiredRoles = requireUniqueStrings(set.requiredRoles, `${setId}/requiredRoles`).map(
      (role) => requireKnownRole(role, definition, `${setId}/requiredRoles`)
    );
    const requiredContexts = requireUniqueStrings(
      set.requiredContexts,
      `${setId}/requiredContexts`
    ).map((context) => requireContractId(context, `${setId}/requiredContexts`));
    const requiredLanguages = requireUniqueStrings(
      set.requiredLanguages,
      `${setId}/requiredLanguages`
    );
    if (!Array.isArray(set.requiredPairs) || set.requiredPairs.length === 0) {
      throw new Error(`Invalid theme specimen contract: ${setId}/requiredPairs must be non-empty.`);
    }
    const pairIds = new Set();
    /** @type {Array<[string, string]>} */
    const requiredPairs = set.requiredPairs.map((pair, index) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new Error(
          `Invalid theme specimen contract: ${setId}/requiredPairs/${index} must contain two roles.`
        );
      }
      const left = requireKnownRole(pair[0], definition, `${setId}/requiredPairs/${index}`);
      const right = requireKnownRole(pair[1], definition, `${setId}/requiredPairs/${index}`);
      if (left === right) {
        throw new Error(
          `Invalid theme specimen contract: ${setId}/requiredPairs/${index} is a self pair.`
        );
      }
      const normalized = /** @type {[string, string]} */ ([left, right].toSorted());
      const pairId = normalized.join('\u0000');
      if (pairIds.has(pairId)) {
        throw new Error(
          `Invalid theme specimen contract: ${setId}/requiredPairs duplicates '${normalized.join(' / ')}'.`
        );
      }
      pairIds.add(pairId);
      return normalized;
    });
    sets[setId] = {
      requiredContexts,
      requiredLanguages,
      requiredPairs,
      requiredRoles,
      specimens: specimenIds,
    };
  }
  const unused = Object.keys(specimens).filter((specimenId) => !usedSpecimens.has(specimenId));
  if (unused.length > 0) {
    throw new Error(
      `Invalid theme specimen contract: specimens are not assigned to a set: ${unused.join(', ')}.`
    );
  }

  return deepFreeze({
    extraction: { neighborhoodTokenRadius },
    schemaVersion: 2,
    sets,
    specimens,
  });
}

/**
 * Compiles witnessed exposure and neighborhood evidence from semantic spans.
 * Missing pairs remain unknown; callers may require the declared coverage gate.
 * @param {ThemeSpecimenContract} contract
 * @param {string} setId
 * @param {{ requireCoverage?: boolean }} [options]
 */
export function compileThemeSpecimenGraph(contract, setId, options = {}) {
  const set = contract.sets[setId];
  if (!set) throw new Error(`Unknown theme specimen set '${setId}'.`);
  /** @type {Map<string, { exposure: number; occurrences: number; role: string; specimens: Set<string> }>} */
  const roles = new Map();
  /** @type {Map<string, { left: string; occurrences: number; right: string; witnesses: Array<{ leftSpan: { end: number; start: number }; rightSpan: { end: number; start: number }; specimen: string }> }>} */
  const edges = new Map();
  const sources = [];
  for (const specimenId of set.specimens) {
    const specimen = contract.specimens[specimenId];
    const tokens = specimenTokens(specimen);
    sources.push({
      annotationSha256: sha256(JSON.stringify(specimen.parts)),
      context: specimen.context,
      language: specimen.language,
      provenance: specimen.provenance,
      purpose: specimen.purpose,
      specimen: specimenId,
    });
    for (const token of tokens) {
      const previous = roles.get(token.role) ?? {
        exposure: 0,
        occurrences: 0,
        role: token.role,
        specimens: new Set(),
      };
      previous.exposure += token.glyphs;
      previous.occurrences += 1;
      previous.specimens.add(specimenId);
      roles.set(token.role, previous);
    }
    for (let leftIndex = 0; leftIndex < tokens.length; leftIndex += 1) {
      const leftToken = tokens[leftIndex];
      for (
        let rightIndex = leftIndex + 1;
        rightIndex <= leftIndex + contract.extraction.neighborhoodTokenRadius &&
        rightIndex < tokens.length;
        rightIndex += 1
      ) {
        const rightToken = tokens[rightIndex];
        if (rightToken.line !== leftToken.line) break;
        if (leftToken.role === rightToken.role) continue;
        const [left, right] = [leftToken.role, rightToken.role].toSorted();
        const edgeId = `${left}\u0000${right}`;
        const previous = edges.get(edgeId) ?? { left, occurrences: 0, right, witnesses: [] };
        previous.occurrences += 1;
        previous.witnesses.push({
          leftSpan:
            leftToken.role === left
              ? { end: leftToken.end, start: leftToken.start }
              : { end: rightToken.end, start: rightToken.start },
          rightSpan:
            rightToken.role === right
              ? { end: rightToken.end, start: rightToken.start }
              : { end: leftToken.end, start: leftToken.start },
          specimen: specimenId,
        });
        edges.set(edgeId, previous);
      }
    }
  }

  const compiledRoles = [...roles.values()]
    .map((entry) => ({ ...entry, specimens: [...entry.specimens].toSorted() }))
    .toSorted(
      (left, right) => right.exposure - left.exposure || left.role.localeCompare(right.role)
    );
  const compiledEdges = [...edges.values()]
    .map((entry) => ({
      ...entry,
      witnesses: entry.witnesses.toSorted(
        (left, right) =>
          left.specimen.localeCompare(right.specimen) || left.leftSpan.start - right.leftSpan.start
      ),
    }))
    .toSorted(
      (left, right) =>
        right.occurrences - left.occurrences ||
        left.left.localeCompare(right.left) ||
        left.right.localeCompare(right.right)
    );
  const witnessedRoles = new Set(compiledRoles.map(({ role }) => role));
  const witnessedPairs = new Set(compiledEdges.map(({ left, right }) => `${left}\u0000${right}`));
  const witnessedContexts = new Set(sources.map(({ context }) => context));
  const witnessedLanguages = new Set(sources.map(({ language }) => language));
  const missingContexts = set.requiredContexts.filter((context) => !witnessedContexts.has(context));
  const missingLanguages = set.requiredLanguages.filter(
    (language) => !witnessedLanguages.has(language)
  );
  const missingRoles = set.requiredRoles.filter((role) => !witnessedRoles.has(role));
  const missingPairs = set.requiredPairs.filter(
    ([left, right]) => !witnessedPairs.has(`${left}\u0000${right}`)
  );
  const coverage = {
    missingContexts,
    missingLanguages,
    missingPairs,
    missingRoles,
    passed:
      missingContexts.length === 0 &&
      missingLanguages.length === 0 &&
      missingRoles.length === 0 &&
      missingPairs.length === 0,
    requiredContextCount: set.requiredContexts.length,
    requiredLanguageCount: set.requiredLanguages.length,
    requiredPairCount: set.requiredPairs.length,
    requiredRoleCount: set.requiredRoles.length,
    witnessedContextCount: set.requiredContexts.length - missingContexts.length,
    witnessedLanguageCount: set.requiredLanguages.length - missingLanguages.length,
    witnessedPairCount: set.requiredPairs.length - missingPairs.length,
    witnessedRoleCount: set.requiredRoles.length - missingRoles.length,
  };
  if (options.requireCoverage && !coverage.passed) {
    const details = [
      missingContexts.length > 0 ? `contexts: ${missingContexts.join(', ')}` : '',
      missingLanguages.length > 0 ? `languages: ${missingLanguages.join(', ')}` : '',
      missingRoles.length > 0 ? `roles: ${missingRoles.join(', ')}` : '',
      missingPairs.length > 0
        ? `pairs: ${missingPairs.map((pair) => pair.join(' / ')).join(', ')}`
        : '',
    ].filter(Boolean);
    throw new Error(`Theme specimen set '${setId}' fails coverage (${details.join('; ')}).`);
  }
  const corpusHash = sha256(
    JSON.stringify({
      extraction: contract.extraction,
      requirements: {
        contexts: set.requiredContexts,
        languages: set.requiredLanguages,
        pairs: set.requiredPairs,
        roles: set.requiredRoles,
      },
      set: setId,
      sources: sources.map(
        ({ annotationSha256, context, language, provenance, purpose, specimen }) => ({
          annotationSha256,
          context,
          kind: provenance.kind,
          language,
          purpose,
          revision: provenance.revision,
          sha256: provenance.sha256,
          specimen,
        })
      ),
    })
  );
  return deepFreeze({
    corpusHash,
    coverage,
    edges: compiledEdges,
    extraction: contract.extraction,
    roles: compiledRoles,
    set: setId,
    sources,
  });
}

/**
 * @param {{ edges: readonly JsonObject[] }} graph
 * @param {string} oneRole
 * @param {string} anotherRole
 * @returns {{ left: string; occurrences: number; right: string; status: 'unknown' | 'witnessed'; witnesses: JsonObject[] }}
 */
export function themeInteractionEvidence(graph, oneRole, anotherRole) {
  const [left, right] = [oneRole, anotherRole].toSorted();
  const edge =
    /** @type {{ left: string; occurrences: number; right: string; witnesses: JsonObject[] } | undefined} */ (
      graph.edges.find((candidate) => candidate.left === left && candidate.right === right)
    );
  return edge
    ? {
        left: edge.left,
        occurrences: edge.occurrences,
        right: edge.right,
        status: /** @type {const} */ ('witnessed'),
        witnesses: edge.witnesses,
      }
    : { left, occurrences: 0, right, status: 'unknown', witnesses: [] };
}

/** @param {ThemeSpecimen} specimen */
function specimenTokens(specimen) {
  let line = 1;
  let offset = 0;
  const tokens = [];
  for (const part of specimen.parts) {
    const start = offset;
    offset += part.text.length;
    if (part.role) {
      tokens.push({
        end: offset,
        glyphs: visibleGlyphs(part.text),
        line,
        role: part.role,
        start,
      });
    }
    line += part.text.split('\n').length - 1;
  }
  return tokens;
}

/** @param {string} value */
function visibleGlyphs(value) {
  return [...value].filter((character) => !/\s/u.test(character)).length;
}

/** @param {unknown} value @param {string} owner @returns {JsonObject} */
function requireObject(value, owner) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid theme specimen contract: ${owner} must be an object.`);
  }
  return /** @type {JsonObject} */ (value);
}

/** @param {JsonObject} value @param {readonly string[]} fields @param {string} owner */
function requireFields(value, fields, owner) {
  if (JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify([...fields].toSorted())) {
    throw new Error(`Invalid theme specimen contract: ${owner} has unsupported or missing fields.`);
  }
}

/** @param {string} value @param {string} kind */
function requireId(value, kind) {
  if (!/^[a-z][a-z0-9-]*$/u.test(value)) {
    throw new Error(`Invalid theme specimen contract: invalid ${kind} id '${value}'.`);
  }
}

/** @param {unknown} value @param {string} owner */
function requireContractId(value, owner) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(value)) {
    throw new Error(`Invalid theme specimen contract: ${owner} must be a kebab-case id.`);
  }
  return value;
}

/** @param {unknown} value @param {string} owner */
function requireText(value, owner) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid theme specimen contract: ${owner} must be non-empty text.`);
  }
  return value;
}

/** @param {unknown} value @param {string} owner */
function requirePositiveInteger(value, owner) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid theme specimen contract: ${owner} must be a positive integer.`);
  }
  return value;
}

/** @param {unknown} value @param {string} owner */
function requireUniqueStrings(value, owner) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === 'string' && item.length > 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(
      `Invalid theme specimen contract: ${owner} must contain unique non-empty strings.`
    );
  }
  return /** @type {string[]} */ (value);
}

/**
 * @param {unknown} value
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition
 * @param {string} owner
 */
function requireKnownRole(value, definition, owner) {
  if (typeof value !== 'string') {
    throw new Error(`Invalid theme specimen contract: ${owner} has a non-string role.`);
  }
  const separator = value.indexOf(':');
  const namespace = value.slice(0, separator);
  const role = value.slice(separator + 1);
  const rolesByNamespace = /** @type {Record<string, readonly string[]>} */ (
    definition.requiredThemeRoles
  );
  if (
    separator <= 0 ||
    !Object.hasOwn(rolesByNamespace, namespace) ||
    !rolesByNamespace[namespace].includes(role)
  ) {
    throw new Error(
      `Invalid theme specimen contract: ${owner} references unknown role '${value}'.`
    );
  }
  return value;
}

/** @param {string} value */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
