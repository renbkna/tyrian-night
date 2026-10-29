import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { buildDesktopThemeAssets } from '../../scripts/desktopThemes.mjs';
import { flattenCssFile } from '../../scripts/union/flattenCss.mjs';
import { lintUnionCss, readLintedUnionSourceCss } from '../../scripts/union/lintUnionCss.mjs';

// The issues a sheet without any checked-state rules reports.
const MISSING_CHECKED_TARGETS = [
  'checkdelegate:checked > indicator',
  'radiodelegate:checked > indicator',
  'switchdelegate:checked > indicator',
  'switchdelegate:checked > indicator > handle',
  'menuitem:checked > indicator',
].map((target) => `Missing checked-state target '${target}'`);

test('Union CSS lint catches known selector regressions', () => {
  const brokenCss = `
progressbar > fill {
  background-color: red;
}

checkdelegate:checked {
  background-color: red;
}

menuitem:checked {
  border: 1px solid red;
}
`;

  expect(lintUnionCss(brokenCss).map((issue) => issue.message)).toEqual([
    'ProgressBar fill must target progressbar > track',
    ...MISSING_CHECKED_TARGETS,
    'Checked checkdelegate row styling must target indicator or handle',
    'Checked menuitem row styling must target indicator or handle',
  ]);
});

test('Union CSS lint requires actual selector rules, not comment text', () => {
  const spoofedCss = `
/*
checkdelegate:checked > indicator { color: red; }
radiodelegate:checked > indicator { color: red; }
switchdelegate:checked > indicator { color: red; }
switchdelegate:checked > indicator > handle { color: red; }
menuitem:checked > indicator { color: red; }
*/
`;

  expect(lintUnionCss(spoofedCss).map((issue) => issue.message)).toEqual([
    ...MISSING_CHECKED_TARGETS,
  ]);
});

test('Union CSS lint reports source lines and ignores constructs inside comments', () => {
  const css = `/* a comment {
spanning lines with calc( and :first-child } */
button {
  width: 50%;
  margin: 2em;
}
`;

  expect(
    lintUnionCss(css)
      .filter((issue) => issue.message.startsWith('Union CSS'))
      .map(({ line, message }) => ({ line, message }))
  ).toEqual([
    { line: 3, message: "Union CSS values should use px or custom properties, not '50%'" },
    { line: 3, message: "Union CSS values should use px or custom properties, not '2em'" },
  ]);
});

test('Union CSS generation lint reports the source file and line of each issue', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-union-lint-origin-'));
  try {
    const unionRoot = path.join(root, 'source/union-css');
    fs.mkdirSync(path.join(unionRoot, 'parts'), { recursive: true });
    fs.writeFileSync(
      path.join(unionRoot, 'index.css'),
      '/* entry */\n\n\n\n@import "./parts/first.css";\n@import "./parts/second.css";\n'
    );
    fs.writeFileSync(path.join(unionRoot, 'parts/first.css'), 'label {\n  color: red;\n}\n\n\n');
    fs.writeFileSync(
      path.join(unionRoot, 'parts/second.css'),
      '/* a\ncomment */\n\nbutton {\n  width: 50%;\n}\n'
    );

    expect(() => readLintedUnionSourceCss(root)).toThrow(
      "- source/union-css/parts/second.css:4: Union CSS values should use px or custom properties, not '50%'"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Union CSS lint rejects unsupported CSS and long combinator chains', () => {
  const brokenCss = `
button:first-child {
  display: flex;
}

applicationwindow page pane button toolbutton {
  color: red;
}

button#primary {
  color: red;
}
`;

  expect(lintUnionCss(brokenCss).map((issue) => issue.message)).toEqual([
    'Union CSS uses unsupported construct :first-child',
    ...MISSING_CHECKED_TARGETS,
    "Union CSS property 'display' is unsupported",
    "Union CSS declaration uses unsupported layout value 'flex'",
    "Selector exceeds the budget of 3 combinators: 'applicationwindow page pane button toolbutton'",
    "Union source CSS must not use ID selectors: 'button#primary'",
  ]);
});

test('Union CSS flattener rejects imports that resolve outside the entry directory', () => {
  const root = makeTempRoot();

  try {
    writeUnionFile(root, 'index.css', '@import "./parts/../../outside/leak.css";\n');
    writeFile(root, 'source/outside/leak.css', 'leaked { color: red; }\n');

    expect(() => flattenCssFile(unionPath(root, 'index.css'))).toThrow(
      'Union CSS imports must stay inside the entry directory'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Union CSS flattener rejects symlinked imports that leave the entry directory', () => {
  const root = makeTempRoot();

  try {
    writeUnionFile(root, 'index.css', '@import "./linked/leak.css";\n');
    writeFile(root, 'outside/leak.css', 'leaked { color: red; }\n');
    fs.symlinkSync(path.join(root, 'outside'), unionPath(root, 'linked'), 'dir');

    expect(() => flattenCssFile(unionPath(root, 'index.css'))).toThrow(
      'Union CSS imports must stay inside the entry directory'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Union CSS flattener admits a file whose name starts with two dots', () => {
  const root = makeTempRoot();

  try {
    writeUnionFile(root, 'index.css', '@import "./..x.css";\n');
    writeUnionFile(root, '..x.css', 'label { color: red; }\n');

    expect(flattenCssFile(unionPath(root, 'index.css'))).toContain('label { color: red; }');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('desktop theme generation rejects invalid Union CSS before producing assets', () => {
  const root = makeTempRoot();

  try {
    copySourceInto(root);
    fs.appendFileSync(
      unionPath(root, 'parts/00-base.css'),
      '\nbutton:first-child {\n  color: red;\n}\n'
    );

    expect(() => buildDesktopThemeAssets(root)).toThrow('Union CSS source failed generation lint');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generation lint rejects text the flattened KDE styles must not contain', () => {
  expect(
    lintUnionCss('/* see Breeze */\nbutton {\n  color: red;\n}\n', { generated: true })
  ).toContainEqual({ message: "Generated Union CSS contains 'Breeze'" });
});

test('desktop theme generation rejects a Union token reference the generator does not define', () => {
  const root = makeTempRoot();

  try {
    copySourceInto(root);
    fs.appendFileSync(
      unionPath(root, 'parts/00-base.css'),
      '\nbutton {\n  color: var(--tyrian-undefined-token);\n}\n'
    );

    expect(() => buildDesktopThemeAssets(root)).toThrow(
      'Union CSS template references undefined tokens: --tyrian-undefined-token.'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-union-css-test-'));
}

function copySourceInto(root: string): void {
  fs.cpSync('source', path.join(root, 'source'), { recursive: true });
}

function unionPath(root: string, relativePath: string): string {
  return path.join(root, 'source/union-css', relativePath);
}

function writeUnionFile(root: string, relativePath: string, content: string): void {
  writeFile(root, path.join('source/union-css', relativePath), content);
}

function writeFile(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}
