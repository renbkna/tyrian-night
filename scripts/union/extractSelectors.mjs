// @ts-check

/**
 * @typedef {{ selector: string; selectors: string[]; body: string; line: number }} CssRule
 */

/**
 * @param {string} css
 * @returns {CssRule[]}
 */
export function extractCssRules(css) {
  const withoutComments = css
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/@property\s+[^{]+\{[^{}]*\}/gu, '');
  const rules = [];
  const ruleRe = /([^{}@]+)\{([^{}]*)\}/gu;
  let match;

  while ((match = ruleRe.exec(withoutComments)) !== null) {
    const selector = match[1].trim();

    if (selector.length === 0 || selector.startsWith(':root') || selector.includes(';')) {
      continue;
    }

    rules.push({
      selector,
      selectors: splitSelectorList(selector),
      body: match[2],
      line: lineNumberAt(withoutComments, match.index),
    });
  }

  return rules;
}

/**
 * @param {string} selectorList
 * @returns {string[]}
 */
export function splitSelectorList(selectorList) {
  return selectorList
    .split(',')
    .map((selector) => selector.trim().replace(/\s+/gu, ' '))
    .filter(Boolean);
}

/**
 * @param {string} selector
 * @returns {string[]}
 */
export function selectorElementNames(selector) {
  return selector
    .split(/\s+|>/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^[.#:]+/u, '').split(/[.#:[>]/u)[0])
    .filter((name) => /^[a-z][a-z0-9-]*$/u.test(name));
}

/**
 * @param {string} selector
 * @returns {string[]}
 */
export function selectorStates(selector) {
  return [...selector.matchAll(/:([a-z-]+)/gu)].map((match) => match[1]);
}

/**
 * @param {string} selector
 * @returns {string[]}
 */
export function selectorHints(selector) {
  return [...selector.matchAll(/\.([a-z][a-z0-9-]*)/gu)].map((match) => match[1]);
}

/**
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}
