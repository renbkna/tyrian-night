import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { buildDesktopThemeAssets } from '../scripts/desktopThemes.mjs';
import { flattenCssFile } from '../scripts/union/flattenCss.mjs';
import { lintUnionCss, readUnionSourceCss } from '../scripts/union/lintUnionCss.mjs';

const sourceCss = readUnionSourceCss();

test('Union CSS source satisfies the KDE 6.7 tech-preview lint contract', () => {
  expect(lintUnionCss(sourceCss, { generated: true })).toEqual([]);
});

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
    "Missing checked-state target 'checkdelegate:checked > indicator'",
    "Missing checked-state target 'radiodelegate:checked > indicator'",
    "Missing checked-state target 'switchdelegate:checked > indicator'",
    "Missing checked-state target 'switchdelegate:checked > indicator > handle'",
    "Missing checked-state target 'menuitem:checked > indicator'",
    'Checked checkdelegate row styling must target indicator or handle',
    'Checked menuitem row styling must target indicator or handle',
  ]);
});

test('Union CSS lint requires actual selector rules, not comment text', () => {
  const spoofedCss = `
/*
checkdelegate:checked > indicator
radiodelegate:checked > indicator
switchdelegate:checked > indicator
switchdelegate:checked > indicator > handle
menuitem:checked > indicator
*/
`;

  expect(lintUnionCss(spoofedCss).map((issue) => issue.message)).toEqual([
    "Missing checked-state target 'checkdelegate:checked > indicator'",
    "Missing checked-state target 'radiodelegate:checked > indicator'",
    "Missing checked-state target 'switchdelegate:checked > indicator'",
    "Missing checked-state target 'switchdelegate:checked > indicator > handle'",
    "Missing checked-state target 'menuitem:checked > indicator'",
  ]);
});

test('Union CSS lint rejects unsupported CSS and specificity arms races', () => {
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
    "Missing checked-state target 'checkdelegate:checked > indicator'",
    "Missing checked-state target 'radiodelegate:checked > indicator'",
    "Missing checked-state target 'switchdelegate:checked > indicator'",
    "Missing checked-state target 'switchdelegate:checked > indicator > handle'",
    "Missing checked-state target 'menuitem:checked > indicator'",
    "Union CSS property 'display' is unsupported",
    "Union CSS declaration uses unsupported layout value 'flex'",
    "Selector exceeds specificity budget: 'applicationwindow page pane button toolbutton'",
    "Union source CSS must not use ID selectors: 'button#primary'",
  ]);
});

test('Union CSS flattener rejects imports that resolve outside the source root', () => {
  const root = makeTempRoot();

  try {
    writeUnionFile(root, 'index.css', '@import "./parts/../../outside/leak.css";\n');
    writeFile(root, 'source/outside/leak.css', 'leaked { color: red; }\n');

    expect(() => flattenCssFile(unionPath(root, 'index.css'))).toThrow(
      'Union CSS imports must stay inside source/union-css'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Union CSS flattener rejects symlinked imports that leave the source root', () => {
  const root = makeTempRoot();

  try {
    writeUnionFile(root, 'index.css', '@import "./linked/leak.css";\n');
    writeFile(root, 'outside/leak.css', 'leaked { color: red; }\n');
    fs.symlinkSync(path.join(root, 'outside'), unionPath(root, 'linked'), 'dir');

    expect(() => flattenCssFile(unionPath(root, 'index.css'))).toThrow(
      'Union CSS imports must stay inside source/union-css'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('desktop theme generation rejects invalid Union CSS before producing assets', () => {
  const root = makeTempRepoFixture();

  try {
    fs.appendFileSync(
      unionPath(root, 'parts/00-base.css'),
      '\nbutton:first-child {\n  color: red;\n}\n'
    );

    expect(() => buildDesktopThemeAssets(root)).toThrow('Union CSS source failed generation lint');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-union-css-test-'));
}

function makeTempRepoFixture(): string {
  const root = makeTempRoot();

  fs.mkdirSync(path.join(root, 'source'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apps/desktop'), { recursive: true });
  fs.copyFileSync('apps/desktop/package.json', path.join(root, 'apps/desktop/package.json'));
  fs.copyFileSync(
    'source/themeRoleContract.json',
    path.join(root, 'source/themeRoleContract.json')
  );
  fs.copyFileSync(
    'source/themeColorBindings.json',
    path.join(root, 'source/themeColorBindings.json')
  );
  fs.copyFileSync(
    'source/themeOpacityContract.json',
    path.join(root, 'source/themeOpacityContract.json')
  );
  fs.copyFileSync(
    'source/themeFamilyContract.json',
    path.join(root, 'source/themeFamilyContract.json')
  );
  fs.copyFileSync('source/themeCatalog.json', path.join(root, 'source/themeCatalog.json'));
  fs.cpSync('source/themes', path.join(root, 'source/themes'), { recursive: true });
  fs.cpSync('source/union-css', path.join(root, 'source/union-css'), { recursive: true });

  return root;
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
