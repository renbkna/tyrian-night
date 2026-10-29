// @ts-check

/**
 * @typedef {{ selector: string; selectors: string[]; body: string; line: number }} CssRule
 */

/**
 * @param {string} css
 * @returns {CssRule[]}
 */
export function extractCssRules(css) {
  const withoutComments = blankCssComments(css).replace(/@property\s+[^{]+\{[^{}]*\}/gu, blank);
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
      selectors: selector
        .split(',')
        .map((selector) => selector.trim().replace(/\s+/gu, ' '))
        .filter(Boolean),
      body: match[2],
      line: lineNumberAt(
        withoutComments,
        match.index + match[1].length - match[1].trimStart().length
      ),
    });
  }

  return rules;
}

/**
 * Replaces each comment with spaces, keeping its newlines so offsets and line
 * numbers still match the source.
 * @param {string} css
 * @returns {string}
 */
export function blankCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, blank);
}

/** @param {string} text */
function blank(text) {
  return text.replace(/[^\n]/gu, ' ');
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
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}
