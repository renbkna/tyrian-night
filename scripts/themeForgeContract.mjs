// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readThemeAppearanceContract } from './themeAppearance.mjs';
import { loadThemeDefinitionContext } from './themeDefinition.mjs';
import { compileThemeSpecimenGraph, readThemeSpecimens } from './themeSpecimens.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @typedef {Record<string, any>} JsonObject */

export const THEME_FORGE_CONTRACT_PATH = path.join(ROOT, 'source', 'themeForgeContract.json');

/**
 * Loads the advisory proposal envelope against the normative appearance and
 * specimen contracts from the same repository root.
 * @param {string} [contractPath]
 * @param {{ appearanceContract?: JsonObject; definition?: import('./themeDefinition.mjs').ThemeDefinitionContext; specimenContract?: import('./themeSpecimens.mjs').ThemeSpecimenContract }} [options]
 */
export function readThemeForgeContract(contractPath = THEME_FORGE_CONTRACT_PATH, options = {}) {
  const root = path.resolve(path.dirname(contractPath), '..');
  const definition = options.definition ?? loadThemeDefinitionContext(root);
  if (definition.root !== root) {
    throw new Error('Theme forge contract and definition roots must match.');
  }
  const appearanceContract =
    options.appearanceContract ??
    readThemeAppearanceContract(path.join(root, 'source/themeAppearanceContract.json'));
  const specimenContract =
    options.specimenContract ??
    readThemeSpecimens(path.join(root, 'source/themeSpecimens.json'), definition);
  return validateThemeForgeContract(JSON.parse(fs.readFileSync(contractPath, 'utf8')), {
    appearanceContract,
    definition,
    specimenContract,
  });
}

/**
 * @param {unknown} value
 * @param {{ appearanceContract?: JsonObject; definition?: import('./themeDefinition.mjs').ThemeDefinitionContext; specimenContract?: import('./themeSpecimens.mjs').ThemeSpecimenContract }} [options]
 */
export function validateThemeForgeContract(value, options = {}) {
  const definition = options.definition ?? loadThemeDefinitionContext(ROOT);
  const appearanceContract =
    options.appearanceContract ??
    readThemeAppearanceContract(path.join(definition.root, 'source/themeAppearanceContract.json'));
  const specimenContract =
    options.specimenContract ??
    readThemeSpecimens(path.join(definition.root, 'source/themeSpecimens.json'), definition);
  const forge = requireObject(value, 'root');
  requireFields(
    forge,
    [
      'appearanceThemeSet',
      'candidatePoolSize',
      'chromaScales',
      'harmonyRole',
      'hueOffsets',
      'maximumJointPigments',
      'schemaVersion',
      'search',
      'specimenSet',
      'toneOffsets',
    ],
    'root'
  );
  invariant(forge.schemaVersion === 1, 'schemaVersion must be 1');
  invariant(
    typeof forge.appearanceThemeSet === 'string' &&
      Object.hasOwn(appearanceContract.themeSets, forge.appearanceThemeSet),
    `appearanceThemeSet references unknown appearance theme set ${forge.appearanceThemeSet}`
  );
  const harmonyRole = requireKnownRole(forge.harmonyRole, definition, 'harmonyRole');
  invariant(
    typeof forge.specimenSet === 'string' &&
      Object.hasOwn(specimenContract.sets, forge.specimenSet),
    `specimenSet references unknown specimen set ${forge.specimenSet}`
  );
  compileThemeSpecimenGraph(specimenContract, forge.specimenSet, { requireCoverage: true });

  const hueOffsets = requireUniqueFiniteNumbers(forge.hueOffsets, 'hueOffsets');
  const toneOffsets = requireUniqueFiniteNumbers(forge.toneOffsets, 'toneOffsets');
  const chromaScales = requireUniqueFiniteNumbers(forge.chromaScales, 'chromaScales');
  invariant(
    chromaScales.every((scale) => scale > 0),
    'chromaScales must be positive'
  );
  invariant(
    Number.isInteger(forge.candidatePoolSize) &&
      forge.candidatePoolSize >= 2 &&
      forge.candidatePoolSize <= 64,
    'candidatePoolSize must be an integer from 2 through 64'
  );
  invariant(
    Number.isInteger(forge.maximumJointPigments) &&
      forge.maximumJointPigments >= 2 &&
      forge.maximumJointPigments <= 8,
    'maximumJointPigments must be an integer from 2 through 8'
  );

  const search = requireObject(forge.search, 'search');
  requireFields(search, ['algorithm', 'beamWidth', 'seed', 'variableOrders'], 'search');
  invariant(search.algorithm === 'seeded-beam-v1', 'search algorithm is unsupported');
  invariant(
    Number.isInteger(search.beamWidth) && search.beamWidth >= 2 && search.beamWidth <= 512,
    'search beamWidth must be an integer from 2 through 512'
  );
  invariant(
    Number.isSafeInteger(search.seed) && search.seed >= 0,
    'search seed must be a non-negative safe integer'
  );
  invariant(
    Number.isInteger(search.variableOrders) &&
      search.variableOrders >= 1 &&
      search.variableOrders <= 16,
    'search variableOrders must be an integer from 1 through 16'
  );

  return deepFreeze({
    appearanceThemeSet: forge.appearanceThemeSet,
    candidatePoolSize: forge.candidatePoolSize,
    chromaScales,
    harmonyRole,
    hueOffsets,
    maximumJointPigments: forge.maximumJointPigments,
    schemaVersion: 1,
    search: {
      algorithm: search.algorithm,
      beamWidth: search.beamWidth,
      seed: search.seed,
      variableOrders: search.variableOrders,
    },
    specimenSet: forge.specimenSet,
    toneOffsets,
  });
}

/** @param {unknown} value @param {string} owner */
function requireObject(value, owner) {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${owner} must be an object`
  );
  return /** @type {JsonObject} */ (value);
}

/** @param {JsonObject} value @param {readonly string[]} fields @param {string} owner */
function requireFields(value, fields, owner) {
  invariant(
    JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify([...fields].toSorted()),
    `${owner} has unsupported or missing fields`
  );
}

/** @param {unknown} value @param {string} owner */
function requireUniqueFiniteNumbers(value, owner) {
  invariant(
    Array.isArray(value) && value.length > 0 && value.every(Number.isFinite),
    `${owner} must contain finite numbers`
  );
  invariant(new Set(value).size === value.length, `${owner} must not contain duplicates`);
  return /** @type {number[]} */ ([...value]);
}

/** @param {unknown} value @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition @param {string} owner */
function requireKnownRole(value, definition, owner) {
  invariant(typeof value === 'string', `${owner} must be a role`);
  const separator = value.indexOf(':');
  const namespace = value.slice(0, separator);
  const role = value.slice(separator + 1);
  const rolesByNamespace = /** @type {Record<string, readonly string[]>} */ (
    definition.requiredThemeRoles
  );
  invariant(
    separator > 0 &&
      Object.hasOwn(rolesByNamespace, namespace) &&
      rolesByNamespace[namespace].includes(role),
    `${owner} references unknown role ${value}`
  );
  return value;
}

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function invariant(condition, message) {
  if (!condition) throw new Error(`Invalid theme forge contract: ${message}`);
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}
