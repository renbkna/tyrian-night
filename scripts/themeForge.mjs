// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { calcAPCA } from 'apca-w3';
import { Blend } from '../node_modules/@material/material-color-utilities/blend/blend.js';
import { Hct } from '../node_modules/@material/material-color-utilities/hct/hct.js';
import { TemperatureCache } from '../node_modules/@material/material-color-utilities/temperature/temperature_cache.js';
import { argbToHex, colorMetrics, compareColors, hexToArgb } from './colorScience.mjs';
import { opaqueHex } from './colorUtils.mjs';
import { COLOR_VISION_MODES, simulateColorVision } from './colorVision.mjs';
import { auditThemeAppearance, readThemeAppearanceContract } from './themeAppearance.mjs';
import { resolveThemeRecipe, themeColor, themePigmentOwner } from './themeDefinition.mjs';
import { readThemeForgeContract } from './themeForgeContract.mjs';
import { loadThemeRepository, readSourceThemeRecipe } from './themeSources.mjs';
import {
  compileThemeSpecimenGraph,
  readThemeSpecimens,
  themeInteractionEvidence,
} from './themeSpecimens.mjs';

const MOVES = new Set(['cooler', 'promote', 'quiet', 'separate', 'warmer']);
const CLAIM = 'best-found-within-declared-corpus-candidate-and-search-envelope';

/** @typedef {{ maximum: number; total: number }} VectorSummary */
/** @typedef {{ changeDelta: number; harmonyDelta: number; hex: string; metrics: Record<string, any>; pigment: string; temperature: number }} PigmentMetric */
/** @typedef {{ absoluteLc: number; exposure: number; role: string }} RoleProminence */
/** @typedef {{ edgeCount: number; exposure: number; minimumCvdOklabDelta: number; minimumOklabDelta: number; occurrenceWeightedCvdOklabDelta: number; occurrenceWeightedOklabDelta: number; occurrences: number; requestedPairs: Array<{ left: string; occurrences: number; right: string; status: string }>; worstEdges: Array<Record<string, any>> }} InteractionMetric */
/** @typedef {{ change: VectorSummary; harmony: VectorSummary; interaction: InteractionMetric; key: string; pigmentMetrics: PigmentMetric[]; pigments: Record<string, string>; regressions: Record<string, any>[]; remainingViolations: Record<string, any>[]; resolved: Record<string, any>[]; roleProminence: RoleProminence[] }} PaletteEvaluation */
/** @typedef {{ edges: Array<{ left: string; occurrences: number; right: string; witnesses: Array<Record<string, any>> }>; roles: Array<{ exposure: number; role: string }> }} SpecimenGraph */

/**
 * Proposes several interacting source-pigment edits without writing a palette.
 * Repository constraints are hard and lexicographically precede witnessed
 * neighborhood robustness, advisory color science, harmony, and minimal change.
 *
 * @param {string} themeSlug
 * @param {readonly string[]} roles
 * @param {{ limit?: number; move?: string; root?: string }} [options]
 */
export function proposeThemePalette(themeSlug, roles, options = {}) {
  const requestedRoles = requireRequestedRoles(roles);
  const repository = loadThemeRepository(options.root);
  const source = repository.sources.find((candidate) => candidate.slug === themeSlug);
  if (!source) throw new Error(`Unknown source theme '${themeSlug}'.`);
  const specimenContract = readThemeSpecimens(
    path.join(repository.root, 'source/themeSpecimens.json'),
    repository.definition
  );
  const contract = readThemeAppearanceContract(
    path.join(repository.root, 'source/themeAppearanceContract.json')
  );
  const forge = readThemeForgeContract(
    path.join(repository.root, 'source/themeForgeContract.json'),
    {
      appearanceContract: contract,
      definition: repository.definition,
      specimenContract,
    }
  );
  const forgeThemes = contract.themeSets[forge.appearanceThemeSet];
  if (!forgeThemes.includes(themeSlug)) {
    throw new Error(
      `Theme '${themeSlug}' is not admitted by forge appearance theme set '${forge.appearanceThemeSet}'.`
    );
  }
  const admittedRoles = new Set(specimenContract.sets[forge.specimenSet].requiredRoles);
  for (const role of requestedRoles) {
    if (!admittedRoles.has(role)) {
      throw new Error(
        `Role '${role}' is not admitted by specimen set '${forge.specimenSet}' requiredRoles.`
      );
    }
  }
  const graph = compileThemeSpecimenGraph(specimenContract, forge.specimenSet, {
    requireCoverage: true,
  });
  const recipe = readSourceThemeRecipe(source, repository.root, repository.definition);
  const theme = resolveThemeRecipe(recipe, source.slug, repository.definition);
  const owners = resolveOwners(repository.definition, recipe, requestedRoles);
  if (owners.length > forge.maximumJointPigments) {
    throw new Error(
      `Joint proposal owns ${owners.length} pigments; the forge contract permits at most ${forge.maximumJointPigments}.`
    );
  }
  const move = options.move ?? 'separate';
  if (!MOVES.has(move)) throw new Error(`Unknown color move '${move}'.`);
  const limit = options.limit ?? 12;
  if (!Number.isInteger(limit) || limit <= 0 || limit > forge.search.beamWidth) {
    throw new Error(
      `Palette proposal limit must be an integer from 1 through ${forge.search.beamWidth}.`
    );
  }

  const baselineViolations = auditThemeAppearance(theme, themeSlug, contract);
  const baselineById = new Map(baselineViolations.map((entry) => [violationId(entry), entry]));
  const allOwnedRoles = [...new Set(owners.flatMap(({ ownedRoles }) => ownedRoles))].toSorted();
  const baselinePigments = Object.fromEntries(
    owners.map(({ current, pigment }) => [pigment, current])
  );
  const harmony = themeColor(theme, forge.harmonyRole).slice(0, 7);
  const evaluationCache = new Map();
  const evaluate = (/** @type {Record<string, string>} */ pigments) => {
    const complete = Object.fromEntries(
      owners.map(({ current, pigment }) => [pigment, pigments[pigment] ?? current])
    );
    const key = assignmentKey(complete);
    const cached = evaluationCache.get(key);
    if (cached) return cached;
    const candidateRecipe = structuredClone(recipe);
    for (const [pigment, hex] of Object.entries(complete)) candidateRecipe.pigments[pigment] = hex;
    const candidateTheme = resolveThemeRecipe(candidateRecipe, source.slug, repository.definition);
    const candidateBackground = themeColor(candidateTheme, contract.reference.background);
    const violations = auditThemeAppearance(candidateTheme, themeSlug, contract);
    const candidateById = new Map(violations.map((entry) => [violationId(entry), entry]));
    const regressions = violations.filter((entry) => !baselineById.has(violationId(entry)));
    const resolved = baselineViolations.filter((entry) => !candidateById.has(violationId(entry)));
    const interaction = paletteInteractionEvidence(
      candidateTheme,
      allOwnedRoles,
      requestedRoles,
      graph,
      candidateBackground
    );
    const roleProminence = requestedRoles
      .map((role) => {
        const graphRole = graph.roles.find((entry) => entry.role === role);
        return {
          absoluteLc: Math.abs(apca(themeColor(candidateTheme, role), candidateBackground)),
          exposure: graphRole?.exposure ?? 0,
          role,
        };
      })
      .toSorted(
        (left, right) => right.exposure - left.exposure || left.role.localeCompare(right.role)
      );
    const pigmentMetrics = owners.map(({ current, pigment }) => {
      const hex = complete[pigment];
      const harmonized = argbToHex(Blend.harmonize(hexToArgb(hex), hexToArgb(harmony)));
      return {
        changeDelta: compareColors({ left: current, right: hex }).oklabDelta,
        harmonyDelta: compareColors({ left: hex, right: harmonized }).oklabDelta,
        hex,
        metrics: colorMetrics(hex),
        pigment,
        temperature: TemperatureCache.rawTemperature(Hct.fromInt(hexToArgb(hex))),
      };
    });
    const result = /** @type {PaletteEvaluation} */ ({
      change: vectorSummary(pigmentMetrics.map(({ changeDelta }) => changeDelta)),
      harmony: vectorSummary(pigmentMetrics.map(({ harmonyDelta }) => harmonyDelta)),
      interaction,
      key,
      pigmentMetrics,
      pigments: complete,
      regressions,
      remainingViolations: violations,
      resolved,
      roleProminence,
    });
    evaluationCache.set(key, result);
    return result;
  };

  const baseline = evaluate(baselinePigments);
  /** @type {Record<string, string[]>} */
  const candidatePools = {};
  /** @type {Record<string, Record<string, any>>} */
  const candidatePoolReports = {};
  /** @type {Record<string, Map<string, Record<string, any>>>} */
  const lineageByPigment = {};
  for (const owner of owners) {
    const generated = generateCandidates(owner.current, harmony, forge);
    const scored = generated.map((candidate) => ({
      candidate,
      evaluation: evaluate({ ...baselinePigments, [owner.pigment]: candidate.hex }),
    }));
    const selected = selectCandidatePool(scored, owner.current, forge.candidatePoolSize, move);
    candidatePools[owner.pigment] = selected.map(({ candidate }) => candidate.hex);
    lineageByPigment[owner.pigment] = new Map(
      selected.map(({ candidate }) => [candidate.hex, candidate.derivation])
    );
    const selectedHex = new Set(selected.map(({ candidate }) => candidate.hex));
    const excluded = scored.filter(({ candidate }) => !selectedHex.has(candidate.hex));
    candidatePoolReports[owner.pigment] = {
      excluded: {
        contractValid: excluded.filter(
          ({ evaluation }) => evaluation.remainingViolations.length === 0
        ).length,
        searchOnly: excluded.filter(({ evaluation }) => evaluation.remainingViolations.length > 0)
          .length,
      },
      generated: generated.length,
      selected: selected.length,
      selectedContractValid: selected.filter(
        ({ evaluation }) => evaluation.remainingViolations.length === 0
      ).length,
      selectedHex: [...selectedHex],
      selectedSearchOnly: selected.filter(
        ({ evaluation }) => evaluation.remainingViolations.length > 0
      ).length,
      selection:
        'lexicographic-contract-ranking-with-source-retention-and-search-only-oklab-diversity-reserve',
      sourceIncluded: selectedHex.has(owner.current),
    };
  }

  const search = seededBeamSearch({
    baseline: baselinePigments,
    beamWidth: forge.search.beamWidth,
    candidates: candidatePools,
    compare: (left, right) => comparePaletteCandidates(left, right, move),
    evaluate,
    seed: forge.search.seed,
    variableOrders: forge.search.variableOrders,
    variables: owners.map(({ pigment }) => pigment),
  });
  const contractValidResults = search.results.filter(
    ({ evaluation }) => evaluation.remainingViolations.length === 0
  );
  const candidates = contractValidResults.slice(0, limit).map(({ evaluation }) => ({
    ...candidateReport(evaluation),
    changes: Object.fromEntries(
      Object.entries(evaluation.pigments).filter(
        ([pigment, hex]) => baselinePigments[pigment] !== hex
      )
    ),
    lineage: Object.fromEntries(
      owners.map(({ pigment }) => [
        pigment,
        lineageByPigment[pigment].get(evaluation.pigments[pigment]),
      ])
    ),
  }));
  const workspacePackage = JSON.parse(
    fs.readFileSync(path.join(repository.root, 'package.json'), 'utf8')
  );
  const sourcePath = path.join(repository.root, source.sourcePath);
  const result = {
    authority: {
      appearanceContractSchema: contract.schemaVersion,
      appearanceContractSha256: sha256(canonicalJson(contract)),
      bindingContractSha256: sha256(
        fs.readFileSync(path.join(repository.root, 'source/themeColorBindings.json'))
      ),
      exactColors: source.sourcePath,
      forgeContractSchema: forge.schemaVersion,
      forgeContractSha256: sha256(canonicalJson(forge)),
      roleContractSha256: sha256(
        fs.readFileSync(path.join(repository.root, 'source/themeRoleContract.json'))
      ),
      sourceSha256: sha256(fs.readFileSync(sourcePath)),
    },
    baseline: baselineReport(baseline),
    certificate: {
      candidatePools: candidatePoolReports,
      claim: CLAIM,
      corpus: {
        coverage: graph.coverage,
        hash: graph.corpusHash,
        set: graph.set,
        sources: graph.sources,
      },
      measurements: {
        apca: workspacePackage.devDependencies['apca-w3'],
        authority: 'advisory-measurement-repository-contract-owns-thresholds',
        materialColorUtilities:
          workspacePackage.devDependencies['@material/material-color-utilities'],
      },
      search: {
        algorithm: forge.search.algorithm,
        beamWidth: forge.search.beamWidth,
        contractValidAssignments: contractValidResults.length,
        evaluatedAssignments: evaluationCache.size,
        orders: search.orders,
        rejectedAssignments: search.results.length - contractValidResults.length,
        seed: forge.search.seed,
      },
      writes: false,
    },
    move,
    owners: owners.map(({ current, ownedRoles, pigment, requestedRoles: ownerRoles }) => ({
      current,
      ownedRoles,
      pigment,
      requestedRoles: ownerRoles,
    })),
    requestedRoles,
    theme: themeSlug,
  };
  return candidates.length > 0
    ? { ...result, candidates, status: /** @type {'found'} */ ('found') }
    : {
        ...result,
        reason: 'bounded-search-found-no-contract-valid-assignment',
        status: /** @type {'no-contract-valid-proposal'} */ ('no-contract-valid-proposal'),
      };
}

/** @param {PaletteEvaluation} evaluation */
function baselineReport(evaluation) {
  return {
    change: evaluation.change,
    harmony: evaluation.harmony,
    interaction: evaluation.interaction,
    pigmentMetrics: evaluation.pigmentMetrics,
    pigments: evaluation.pigments,
    roleProminence: evaluation.roleProminence,
    violations: evaluation.remainingViolations,
  };
}

/** @param {PaletteEvaluation} evaluation */
function candidateReport(evaluation) {
  return {
    change: evaluation.change,
    harmony: evaluation.harmony,
    interaction: evaluation.interaction,
    pigmentMetrics: evaluation.pigmentMetrics,
    pigments: evaluation.pigments,
    resolved: evaluation.resolved,
    roleProminence: evaluation.roleProminence,
  };
}

/**
 * Deterministic bounded joint-search mechanism. Policy lives in the supplied
 * evaluator/comparator; this function owns only exploration and reproducibility.
 * @template T
 * @param {{ baseline: Record<string, string>; beamWidth: number; candidates: Record<string, string[]>; compare: (left: T, right: T) => number; evaluate: (assignment: Record<string, string>) => T; seed: number; variableOrders: number; variables: string[] }} options
 */
export function seededBeamSearch(options) {
  const variables = [...options.variables].toSorted();
  if (variables.length === 0 || new Set(variables).size !== variables.length) {
    throw new Error('Seeded beam search requires unique variables.');
  }
  const candidateSets = new Map();
  for (const variable of variables) {
    const candidates = options.candidates[variable];
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error(`Seeded beam search has no candidates for '${variable}'.`);
    }
    candidateSets.set(variable, [...new Set(candidates)].toSorted());
  }
  const orders = seededVariableOrders(
    variables,
    options.seed,
    Math.min(options.variableOrders, factorialLimit(variables.length))
  );
  const finalStates = new Map();
  for (const order of orders) {
    let beam = [searchState(options.baseline, options.evaluate)];
    for (const variable of order) {
      const expanded = new Map();
      for (const state of beam) {
        for (const candidate of candidateSets.get(variable)) {
          const assignment = { ...state.assignment, [variable]: candidate };
          const next = searchState(assignment, options.evaluate);
          expanded.set(next.key, next);
        }
      }
      beam = [...expanded.values()]
        .toSorted(
          (left, right) =>
            options.compare(left.evaluation, right.evaluation) || left.key.localeCompare(right.key)
        )
        .slice(0, options.beamWidth);
    }
    for (const state of beam) finalStates.set(state.key, state);
  }
  return {
    orders,
    results: [...finalStates.values()].toSorted(
      (left, right) =>
        options.compare(left.evaluation, right.evaluation) || left.key.localeCompare(right.key)
    ),
  };
}

/** @param {Record<string, string>} assignment @param {(assignment: Record<string, string>) => any} evaluate */
function searchState(assignment, evaluate) {
  const normalized = Object.fromEntries(
    Object.entries(assignment).toSorted(([left], [right]) => left.localeCompare(right))
  );
  return {
    assignment: normalized,
    evaluation: evaluate(normalized),
    key: assignmentKey(normalized),
  };
}

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition
 * @param {Record<string, any>} recipe
 * @param {readonly string[]} requestedRoles
 */
function resolveOwners(definition, recipe, requestedRoles) {
  /** @type {Map<string, { current: string; ownedRoles: string[]; pigment: string; requestedRoles: string[] }>} */
  const owners = new Map();
  for (const role of requestedRoles) {
    const pigment = themePigmentOwner(definition, recipe.bindingProfile, role);
    const owner =
      owners.get(pigment) ??
      /** @type {{ current: string; ownedRoles: string[]; pigment: string; requestedRoles: string[] }} */ ({
        current: recipe.pigments[pigment],
        ownedRoles: pigmentRoles(definition, recipe.bindingProfile, pigment),
        pigment,
        requestedRoles: [],
      });
    owner.requestedRoles.push(role);
    owners.set(pigment, owner);
  }
  return [...owners.values()]
    .map((owner) => ({
      ...owner,
      requestedRoles: owner.requestedRoles.toSorted(),
    }))
    .toSorted((left, right) => left.pigment.localeCompare(right.pigment));
}

/** @param {string} current @param {string} harmony @param {Record<string, any>} forge */
function generateCandidates(current, harmony, forge) {
  const source = Hct.fromInt(hexToArgb(current));
  /** @type {Map<string, Record<string, any>>} */
  const values = new Map([[current, { algorithm: 'source', source: current }]]);
  for (const hueOffset of forge.hueOffsets) {
    for (const chromaScale of forge.chromaScales) {
      for (const toneOffset of forge.toneOffsets) {
        const candidate = argbToHex(
          Hct.from(
            wrapHue(source.hue + hueOffset),
            Math.max(0, source.chroma * chromaScale),
            clamp(source.tone + toneOffset, 0, 100)
          ).toInt()
        );
        if (!values.has(candidate)) {
          values.set(candidate, {
            algorithm: 'mcu-hct-grid',
            chromaScale,
            hueOffset,
            source: current,
            toneOffset,
          });
        }
        const harmonized = argbToHex(Blend.harmonize(hexToArgb(candidate), hexToArgb(harmony)));
        if (!values.has(harmonized)) {
          values.set(harmonized, {
            algorithm: 'mcu-hct-grid-harmonized',
            candidate,
            chromaScale,
            harmony,
            hueOffset,
            source: current,
            toneOffset,
          });
        }
      }
    }
  }
  return [...values]
    .map(([hex, derivation]) => ({ derivation, hex }))
    .toSorted((left, right) => left.hex.localeCompare(right.hex));
}

/**
 * Keeps the locally strongest candidates while reserving part of the bounded
 * pool for perceptually distinct alternatives that can improve only jointly.
 * @param {Array<{ candidate: { derivation: any; hex: string }; evaluation: any }>} scored
 * @param {string} current
 * @param {number} limit
 * @param {string} move
 */
function selectCandidatePool(scored, current, limit, move) {
  const ranked = scored.toSorted(
    (left, right) =>
      comparePaletteCandidates(left.evaluation, right.evaluation, move) ||
      left.candidate.hex.localeCompare(right.candidate.hex)
  );
  if (ranked.length <= limit) return ranked;
  const currentEntry = ranked.find(({ candidate }) => candidate.hex === current);
  const selected = ranked.slice(0, Math.max(1, Math.floor(limit * 0.75)));
  const selectedHex = new Set(selected.map(({ candidate }) => candidate.hex));
  if (currentEntry && !selectedHex.has(current)) {
    selected.push(currentEntry);
    selectedHex.add(current);
  }
  while (selected.length < limit) {
    let best;
    let bestDistance = Number.NEGATIVE_INFINITY;
    for (const entry of ranked) {
      if (selectedHex.has(entry.candidate.hex)) continue;
      const minimumDistance = Math.min(
        ...selected.map(
          ({ candidate }) =>
            compareColors({ left: candidate.hex, right: entry.candidate.hex }).oklabDelta
        )
      );
      if (
        minimumDistance > bestDistance ||
        (minimumDistance === bestDistance &&
          (!best || comparePaletteCandidates(entry.evaluation, best.evaluation, move) < 0))
      ) {
        best = entry;
        bestDistance = minimumDistance;
      }
    }
    if (!best) break;
    selected.push(best);
    selectedHex.add(best.candidate.hex);
  }
  return selected.toSorted(
    (left, right) =>
      comparePaletteCandidates(left.evaluation, right.evaluation, move) ||
      left.candidate.hex.localeCompare(right.candidate.hex)
  );
}

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {readonly string[]} ownedRoles
 * @param {readonly string[]} requestedRoles
 * @param {SpecimenGraph} graph
 * @param {string} background
 */
function paletteInteractionEvidence(theme, ownedRoles, requestedRoles, graph, background) {
  const owned = new Set(ownedRoles);
  const edges = graph.edges.filter((edge) => owned.has(edge.left) || owned.has(edge.right));
  const edgeMetrics = edges.map((edge) => {
    const left = themeColor(theme, edge.left);
    const right = themeColor(theme, edge.right);
    const oklabDelta = compareColors({ background, left, right }).oklabDelta;
    let minimumCvdOklabDelta = Number.POSITIVE_INFINITY;
    for (const mode of COLOR_VISION_MODES) {
      minimumCvdOklabDelta = Math.min(
        minimumCvdOklabDelta,
        compareColors({
          left: simulateColorVision(left, mode, background),
          right: simulateColorVision(right, mode, background),
        }).oklabDelta
      );
    }
    return {
      left: edge.left,
      minimumCvdOklabDelta,
      occurrences: edge.occurrences,
      oklabDelta,
      right: edge.right,
      witnessCount: edge.witnesses.length,
    };
  });
  const occurrences = edgeMetrics.reduce((sum, edge) => sum + edge.occurrences, 0);
  /** @type {Array<{ left: string; occurrences: number; right: string; status: string }>} */
  const requestedPairs = [];
  for (let leftIndex = 0; leftIndex < requestedRoles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < requestedRoles.length; rightIndex += 1) {
      const evidence = themeInteractionEvidence(
        graph,
        requestedRoles[leftIndex],
        requestedRoles[rightIndex]
      );
      requestedPairs.push({
        left: evidence.left,
        occurrences: evidence.occurrences,
        right: evidence.right,
        status: evidence.status,
      });
    }
  }
  const exposure = graph.roles
    .filter((entry) => owned.has(entry.role))
    .reduce((sum, entry) => sum + entry.exposure, 0);
  return {
    edgeCount: edgeMetrics.length,
    exposure,
    minimumCvdOklabDelta:
      edgeMetrics.length === 0
        ? Number.POSITIVE_INFINITY
        : Math.min(...edgeMetrics.map((edge) => edge.minimumCvdOklabDelta)),
    minimumOklabDelta:
      edgeMetrics.length === 0
        ? Number.POSITIVE_INFINITY
        : Math.min(...edgeMetrics.map((edge) => edge.oklabDelta)),
    occurrenceWeightedCvdOklabDelta:
      occurrences === 0
        ? Number.POSITIVE_INFINITY
        : edgeMetrics.reduce((sum, edge) => sum + edge.minimumCvdOklabDelta * edge.occurrences, 0) /
          occurrences,
    occurrenceWeightedOklabDelta:
      occurrences === 0
        ? Number.POSITIVE_INFINITY
        : edgeMetrics.reduce((sum, edge) => sum + edge.oklabDelta * edge.occurrences, 0) /
          occurrences,
    occurrences,
    requestedPairs,
    worstEdges: edgeMetrics
      .toSorted(
        (left, right) =>
          left.minimumCvdOklabDelta - right.minimumCvdOklabDelta ||
          left.oklabDelta - right.oklabDelta ||
          left.left.localeCompare(right.left)
      )
      .slice(0, 5),
  };
}

/** @param {PaletteEvaluation} left @param {PaletteEvaluation} right @param {string} move */
function comparePaletteCandidates(left, right, move) {
  let order = left.regressions.length - right.regressions.length;
  if (order !== 0) return order;
  order = left.remainingViolations.length - right.remainingViolations.length;
  if (order !== 0) return order;
  order = right.resolved.length - left.resolved.length;
  if (order !== 0) return order;

  if (move === 'promote') order = compareProminence(left, right, true);
  else if (move === 'quiet') order = compareProminence(left, right, false);
  else if (move === 'warmer') order = comparePigmentMetric(left, right, 'temperature', true);
  else if (move === 'cooler') order = comparePigmentMetric(left, right, 'temperature', false);
  else order = compareInteraction(left.interaction, right.interaction);
  if (order !== 0) return order;

  if (move !== 'separate') {
    order = compareInteraction(left.interaction, right.interaction);
    if (order !== 0) return order;
  }
  order = left.harmony.maximum - right.harmony.maximum;
  if (order !== 0) return order;
  order = left.harmony.total - right.harmony.total;
  if (order !== 0) return order;
  order = left.change.maximum - right.change.maximum;
  if (order !== 0) return order;
  order = left.change.total - right.change.total;
  return order !== 0 ? order : left.key.localeCompare(right.key);
}

/** @param {PaletteEvaluation} left @param {PaletteEvaluation} right @param {boolean} descending */
function compareProminence(left, right, descending) {
  for (let index = 0; index < left.roleProminence.length; index += 1) {
    const leftValue = left.roleProminence[index].absoluteLc;
    const rightValue = right.roleProminence[index].absoluteLc;
    const order = descending ? rightValue - leftValue : leftValue - rightValue;
    if (order !== 0) return order;
  }
  return 0;
}

/** @param {PaletteEvaluation} left @param {PaletteEvaluation} right @param {'temperature'} field @param {boolean} descending */
function comparePigmentMetric(left, right, field, descending) {
  const leftValues = left.pigmentMetrics
    .map((entry) => entry[field])
    .toSorted((one, another) => (descending ? another - one : one - another));
  const rightValues = right.pigmentMetrics
    .map((entry) => entry[field])
    .toSorted((one, another) => (descending ? another - one : one - another));
  for (let index = 0; index < leftValues.length; index += 1) {
    const order = descending
      ? rightValues[index] - leftValues[index]
      : leftValues[index] - rightValues[index];
    if (order !== 0) return order;
  }
  return 0;
}

/** @param {InteractionMetric} left @param {InteractionMetric} right */
function compareInteraction(left, right) {
  for (const field of /** @type {Array<'minimumCvdOklabDelta' | 'minimumOklabDelta' | 'occurrenceWeightedCvdOklabDelta' | 'occurrenceWeightedOklabDelta'>} */ ([
    'minimumCvdOklabDelta',
    'minimumOklabDelta',
    'occurrenceWeightedCvdOklabDelta',
    'occurrenceWeightedOklabDelta',
  ])) {
    const order = finiteDescending(left[field], right[field]);
    if (order !== 0) return order;
  }
  return 0;
}

/** @param {number} left @param {number} right */
function finiteDescending(left, right) {
  if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
  if (!Number.isFinite(left)) return 1;
  if (!Number.isFinite(right)) return -1;
  return right - left;
}

/** @param {number[]} values */
function vectorSummary(values) {
  return {
    maximum: values.length === 0 ? 0 : Math.max(...values),
    total: values.reduce((sum, value) => sum + value, 0),
  };
}

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition
 * @param {string} profileName
 * @param {string} pigment
 */
function pigmentRoles(definition, profileName, pigment) {
  const profile = definition.colorBindingProfiles[profileName];
  return Object.entries(profile.bindings).flatMap(([namespace, bindings]) =>
    Object.entries(bindings)
      .filter(
        ([, binding]) => (typeof binding === 'string' ? binding : binding.pigment) === pigment
      )
      .map(([role]) => `${namespace}:${role}`)
  );
}

/** @param {readonly string[]} roles */
function requireRequestedRoles(roles) {
  if (
    !Array.isArray(roles) ||
    roles.length === 0 ||
    !roles.every((role) => typeof role === 'string' && role.length > 0) ||
    new Set(roles).size !== roles.length
  ) {
    throw new Error('Palette proposals require unique non-empty roles.');
  }
  return [...roles].toSorted();
}

/** @param {Record<string, string>} assignment */
function assignmentKey(assignment) {
  return Object.entries(assignment)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([pigment, hex]) => `${pigment}=${hex}`)
    .join('|');
}

/** @param {string[]} variables @param {number} seed @param {number} count */
function seededVariableOrders(variables, seed, count) {
  const orders = [variables];
  const seen = new Set([variables.join('\u0000')]);
  const random = mulberry32(seed);
  for (let attempts = 0; orders.length < count && attempts < count * 32; attempts += 1) {
    const candidate = [...variables];
    for (let index = candidate.length - 1; index > 0; index -= 1) {
      const selected = Math.floor(random() * (index + 1));
      [candidate[index], candidate[selected]] = [candidate[selected], candidate[index]];
    }
    const key = candidate.join('\u0000');
    if (!seen.has(key)) {
      seen.add(key);
      orders.push(candidate);
    }
  }
  return orders;
}

/** @param {number} seed */
function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {number} value */
function factorialLimit(value) {
  let result = 1;
  for (let factor = 2; factor <= value && result < 16; factor += 1) result *= factor;
  return Math.min(result, 16);
}

/** @param {Record<string, any>} violation */
function violationId(violation) {
  return [
    violation.constraint,
    violation.kind,
    violation.role ?? '',
    ...(violation.roles ?? []),
    violation.mode ?? '',
  ].join('|');
}

/** @param {string} foreground @param {string} background */
function apca(foreground, background) {
  const value = calcAPCA(opaqueHex(foreground, background), opaqueHex(background));
  const lc = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(lc)) throw new Error('APCA could not evaluate a proposal.');
  return lc;
}

/** @param {number} hue */
function wrapHue(hue) {
  return ((hue % 360) + 360) % 360;
}

/** @param {number} value @param {number} minimum @param {number} maximum */
function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/** @param {crypto.BinaryLike} value */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** @param {unknown} value @returns {string} */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}
