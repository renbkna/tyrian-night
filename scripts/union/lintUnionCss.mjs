// @ts-check

import path from 'node:path';

import { extractCssRules, selectorElementNames } from './extractSelectors.mjs';
import { flattenCssFile } from './flattenCss.mjs';

const GENERATED_FORBIDDEN_TEXT = [
  '@import',
  '../breeze',
  'custom-color("kcolorscheme"',
  'kcolorscheme',
  'Breeze',
];

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
 * @typedef {{ severity: 'error' | 'warning'; message: string; line?: number }} UnionCssIssue
 */

/**
 * @param {string} repoRoot
 * @returns {string}
 */
export function readUnionSourceCss(repoRoot = process.cwd()) {
  return flattenCssFile(path.join(repoRoot, 'source/union-css/index.css'));
}

/**
 * @param {string} css
 * @param {{ generated?: boolean }} [options]
 * @returns {UnionCssIssue[]}
 */
export function lintUnionCss(css, options = {}) {
  const issues = /** @type {UnionCssIssue[]} */ ([]);
  const rules = extractCssRules(css);
  const selectors = new Set(
    rules.flatMap((rule) => rule.selectors.map((selector) => normalizeSelector(selector)))
  );

  if (options.generated) {
    for (const forbidden of GENERATED_FORBIDDEN_TEXT) {
      if (css.includes(forbidden)) {
        issues.push({ severity: 'error', message: `Generated Union CSS contains '${forbidden}'` });
      }
    }
  }

  for (const { pattern, label } of UNSUPPORTED_TEXT) {
    if (pattern.test(css)) {
      issues.push({ severity: 'error', message: `Union CSS uses unsupported construct ${label}` });
    }
  }

  if (/progressbar\s*>\s*fill/u.test(css)) {
    issues.push({ severity: 'error', message: 'ProgressBar fill must target progressbar > track' });
  }

  for (const target of REQUIRED_CHECKED_TARGETS) {
    if (!selectors.has(normalizeSelector(target))) {
      issues.push({ severity: 'error', message: `Missing checked-state target '${target}'` });
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
    const normalizedSelector = selector.replace(/\s*>\s*/gu, '>');
    const combinatorCount =
      (normalizedSelector.match(/>/gu) ?? []).length +
      (normalizedSelector.match(/\s+/gu) ?? []).length;

    if (combinatorCount > 3) {
      issues.push({
        severity: 'error',
        line: rule.line,
        message: `Selector exceeds specificity budget: '${selector}'`,
      });
    }

    if (selector.includes('#')) {
      issues.push({
        severity: 'error',
        line: rule.line,
        message: `Union source CSS must not use ID selectors: '${selector}'`,
      });
    }

    if (selector.includes('*') && selector !== '*') {
      issues.push({
        severity: 'error',
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
        severity: 'error',
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
        severity: 'error',
        line: rule.line,
        message: `Union CSS property '${name}' is unsupported`,
      });
    }

    if (/^(?:flex|grid)$/u.test(value)) {
      issues.push({
        severity: 'error',
        line: rule.line,
        message: `Union CSS declaration uses unsupported layout value '${value}'`,
      });
    }

    if (/\b\d+(?:\.\d+)?(?:em|rem|vh|vw|%)\b/u.test(value)) {
      issues.push({
        severity: 'error',
        line: rule.line,
        message: `Union CSS lengths should use px/custom properties, not '${value}'`,
      });
    }
  }
}

/**
 * @param {string} selector
 * @returns {string}
 */
function normalizeSelector(selector) {
  return selector
    .replace(/\s*>\s*/gu, ' > ')
    .replace(/\s+/gu, ' ')
    .trim();
}

if (process.argv[1] === import.meta.filename) {
  const repoRoot = process.cwd();
  const css = readUnionSourceCss(repoRoot);
  const issues = lintUnionCss(css, { generated: true });

  if (issues.length > 0) {
    for (const issue of issues) {
      const location = issue.line === undefined ? '' : `:${issue.line}`;
      console.error(`${issue.severity.toUpperCase()}${location} ${issue.message}`);
    }

    process.exitCode = 1;
  }
}
