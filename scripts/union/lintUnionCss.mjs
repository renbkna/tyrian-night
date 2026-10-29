// @ts-check

import path from 'node:path';

import {
  blankCssComments,
  extractCssRules,
  normalizeSelector,
  selectorElementNames,
} from './extractSelectors.mjs';
import { flattenCssLines, UNION_SOURCE_ENTRY } from './flattenCss.mjs';
import { isDirectRun } from '../cli.mjs';

/** Text the generated KDE styles must not contain: they are flattened and self-contained. */
export const GENERATED_FORBIDDEN_TEXT = Object.freeze([
  '@import',
  '../breeze',
  'kcolorscheme',
  'Breeze',
]);

const UNSUPPORTED_TEXT = [
  { pattern: /@media\b/u, label: '@media' },
  { pattern: /calc\s*\(/u, label: 'calc()' },
  { pattern: /:first-child\b/u, label: ':first-child' },
  { pattern: /:last-child\b/u, label: ':last-child' },
];
const UNSUPPORTED_PROPERTIES = new Set(['position', 'display', 'visibility']);
const BAD_CHECKED_ROW_ELEMENTS = ['checkdelegate', 'radiodelegate', 'switchdelegate', 'menuitem'];
const REQUIRED_CHECKED_TARGETS = [
  'checkdelegate:checked > indicator',
  'radiodelegate:checked > indicator',
  'switchdelegate:checked > indicator',
  'switchdelegate:checked > indicator > handle',
  'menuitem:checked > indicator',
];

/**
 * @typedef {{ message: string; line?: number }} UnionCssIssue
 */

/**
 * The Union source, flattened; throws when it fails the generation lint.
 * @param {string} repoRoot
 * @returns {string}
 */
export function readLintedUnionSourceCss(repoRoot) {
  const lines = flattenCssLines(path.join(repoRoot, UNION_SOURCE_ENTRY));
  const css = lines.map(({ text }) => text).join('\n');
  const issues = lintUnionCss(css, { generated: true });
  if (issues.length > 0) {
    /** @param {number} line */
    const location = (line) => {
      const origin = /** @type {import('./flattenCss.mjs').FlattenedCssLine} */ (lines[line - 1]);
      return `${path.relative(repoRoot, origin.file)}:${origin.line}`;
    };
    throw new Error(
      [
        'Union CSS source failed generation lint:',
        ...issues.map(
          ({ message, line }) => `- ${line === undefined ? '' : `${location(line)}: `}${message}`
        ),
      ].join('\n')
    );
  }
  return css;
}

/**
 * @param {string} css
 * @param {{ generated?: boolean }} [options]
 * @returns {UnionCssIssue[]}
 */
export function lintUnionCss(css, options = {}) {
  const issues = /** @type {UnionCssIssue[]} */ ([]);
  const rules = extractCssRules(css);
  const code = blankCssComments(css);
  const selectors = new Set(rules.flatMap((rule) => rule.selectors));

  if (options.generated) {
    for (const forbidden of GENERATED_FORBIDDEN_TEXT) {
      if (css.includes(forbidden)) {
        issues.push({ message: `Generated Union CSS contains '${forbidden}'` });
      }
    }
  }

  for (const { pattern, label } of UNSUPPORTED_TEXT) {
    if (pattern.test(code)) {
      issues.push({ message: `Union CSS uses unsupported construct ${label}` });
    }
  }

  if (/progressbar\s*>\s*fill/u.test(code)) {
    issues.push({ message: 'ProgressBar fill must target progressbar > track' });
  }

  for (const target of REQUIRED_CHECKED_TARGETS) {
    if (!selectors.has(normalizeSelector(target))) {
      issues.push({ message: `Missing checked-state target '${target}'` });
    }
  }

  for (const rule of rules) {
    lintRule(rule, issues);
  }

  return issues;
}

/**
 * @param {import('./extractSelectors.mjs').CssRule} rule
 * @param {UnionCssIssue[]} issues
 * @returns {void}
 */
function lintRule(rule, issues) {
  for (const selector of rule.selectors) {
    const combinatorCount = selector.split(/ > | /u).length - 1;

    if (combinatorCount > 3) {
      issues.push({
        line: rule.line,
        message: `Selector exceeds the budget of 3 combinators: '${selector}'`,
      });
    }

    if (selector.includes('#')) {
      issues.push({
        line: rule.line,
        message: `Union source CSS must not use ID selectors: '${selector}'`,
      });
    }

    if (selector.includes('*') && selector !== '*') {
      issues.push({
        line: rule.line,
        message: `Universal selectors are only allowed as the base reset: '${selector}'`,
      });
    }

    const selectorElements = selectorElementNames(selector);
    const checkedRowElement = selectorElements.find((element) =>
      BAD_CHECKED_ROW_ELEMENTS.includes(element)
    );
    const checkedRowBody = /\bbackground(?:-color)?\s*:|\bborder(?:-color)?\s*:/u.test(rule.body);

    if (
      checkedRowElement !== undefined &&
      selector.includes(':checked') &&
      !/(?:indicator|handle)/u.test(selector) &&
      checkedRowBody
    ) {
      issues.push({
        line: rule.line,
        message: `Checked ${checkedRowElement} row styling must target indicator or handle`,
      });
    }
  }

  for (const declaration of rule.body.split(';')) {
    const [rawName, ...rawValueParts] = declaration.split(':');
    const name = rawName?.trim();
    const value = rawValueParts.join(':').trim();

    if (!name || value.length === 0) {
      continue;
    }

    if (UNSUPPORTED_PROPERTIES.has(name)) {
      issues.push({
        line: rule.line,
        message: `Union CSS property '${name}' is unsupported`,
      });
    }

    if (/^(?:flex|grid)$/u.test(value)) {
      issues.push({
        line: rule.line,
        message: `Union CSS declaration uses unsupported layout value '${value}'`,
      });
    }

    if (/\b\d+(?:\.\d+)?(?:(?:em|rem|vh|vw)\b|%)/u.test(value)) {
      issues.push({
        line: rule.line,
        message: `Union CSS values should use px or custom properties, not '${value}'`,
      });
    }
  }
}

if (isDirectRun(import.meta)) {
  try {
    readLintedUnionSourceCss(path.resolve(import.meta.dirname, '../..'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
