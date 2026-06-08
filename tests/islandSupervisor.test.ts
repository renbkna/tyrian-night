import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { applyIslandShell } from '../apps/vscode/src/islandShell';
import {
  applyIslandUiSupervised,
  readIslandUiSupervisorStatuses,
  restoreIslandUiSupervised,
} from '../apps/vscode/src/islandSupervisor';

const WORKBENCH_DIR = path.join('out', 'vs', 'code', 'electron-browser', 'workbench');
const WORKBENCH_HTML = path.join(WORKBENCH_DIR, 'workbench.html');
const PRODUCT_JSON = 'product.json';
const WORKBENCH_CHECKSUM_KEY = 'vs/code/electron-browser/workbench/workbench.html';
const WORKBENCH_CSS_LINK =
  '<link rel="stylesheet" href="../../../workbench/workbench.desktop.main.css">';

let previousHome: string | undefined;
let registryHome: string;
let testRoot: string;

beforeEach(async () => {
  previousHome = process.env.HOME;
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-night-supervisor-test-'));
  registryHome = path.join(testRoot, 'home');
  process.env.HOME = registryHome;
  await fs.mkdir(registryHome, { recursive: true });
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }

  await fs.rm(testRoot, { force: true, recursive: true });
});

test('supervised apply returns already-current after the shell is current', async () => {
  const appRoot = await createAppRoot('already-current');
  const cssSource = await writeCssSource('theme.css');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });

  await expect(
    applyIslandUiSupervised({
      appRoot,
      cssSourcePath: cssSource,
      themeVersion: 'test',
      registryHome,
    })
  ).resolves.toMatchObject({
    kind: 'already-current',
    changed: false,
    status: {
      classification: 'patched',
    },
  });
});

test('supervised apply converts a read-only app root into permission-required', async () => {
  const appRoot = await createAppRoot('readonly-apply');
  const cssSource = await writeCssSource('theme.css');
  const workbenchDir = path.join(appRoot, WORKBENCH_DIR);
  const workbenchPath = path.join(appRoot, WORKBENCH_HTML);
  const productPath = path.join(appRoot, PRODUCT_JSON);

  try {
    await fs.chmod(workbenchDir, 0o555);
    await fs.chmod(workbenchPath, 0o444);
    await fs.chmod(productPath, 0o444);

    await expect(
      applyIslandUiSupervised({
        appRoot,
        cssSourcePath: cssSource,
        themeVersion: 'test',
        registryHome,
      })
    ).resolves.toMatchObject({
      kind: 'permission-required',
      changed: true,
      writeAccess: {
        writable: false,
      },
    });
  } finally {
    await fs.chmod(workbenchDir, 0o755);
    await fs.chmod(workbenchPath, 0o644);
    await fs.chmod(productPath, 0o644);
  }
});

test('supervisor status recommends write-access repair for clean read-only app roots', async () => {
  const appRoot = await createAppRoot('readonly-status');
  const workbenchDir = path.join(appRoot, WORKBENCH_DIR);
  const workbenchPath = path.join(appRoot, WORKBENCH_HTML);
  const productPath = path.join(appRoot, PRODUCT_JSON);

  try {
    await fs.chmod(workbenchDir, 0o555);
    await fs.chmod(workbenchPath, 0o444);
    await fs.chmod(productPath, 0o444);

    await expect(
      readIslandUiSupervisorStatuses({ preferredAppRoots: [appRoot], registryHome })
    ).resolves.toMatchObject([
      {
        classification: 'clean',
        writeAccess: {
          writable: false,
        },
        recommendedAction: 'elevated-repair',
      },
    ]);
  } finally {
    await fs.chmod(workbenchDir, 0o755);
    await fs.chmod(workbenchPath, 0o644);
    await fs.chmod(productPath, 0o644);
  }
});

test('supervised restore maps write failures to permission-required', async () => {
  const appRoot = await createAppRoot('readonly-restore');
  const cssSource = await writeCssSource('theme.css');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  const workbenchDir = path.join(appRoot, WORKBENCH_DIR);
  const workbenchPath = path.join(appRoot, WORKBENCH_HTML);
  const productPath = path.join(appRoot, PRODUCT_JSON);

  try {
    await fs.chmod(workbenchDir, 0o555);
    await fs.chmod(workbenchPath, 0o444);
    await fs.chmod(productPath, 0o444);

    await expect(
      restoreIslandUiSupervised({ preferredAppRoots: [appRoot], registryHome })
    ).resolves.toMatchObject({
      kind: 'permission-required',
      changed: false,
      failedAppRoots: [{ appRoot, reason: expect.any(String) }],
    });
  } finally {
    await fs.chmod(workbenchDir, 0o755);
    await fs.chmod(workbenchPath, 0o644);
    await fs.chmod(productPath, 0o644);
  }
});

async function createAppRoot(name: string): Promise<string> {
  const appRoot = path.join(testRoot, name);
  const workbenchDir = path.join(appRoot, WORKBENCH_DIR);
  const html = cleanWorkbenchHtml();

  await fs.mkdir(workbenchDir, { recursive: true });
  await fs.writeFile(path.join(appRoot, WORKBENCH_HTML), html, 'utf8');
  await fs.writeFile(path.join(appRoot, PRODUCT_JSON), productJson(sha256Base64(html)), 'utf8');

  return appRoot;
}

async function writeCssSource(name: string): Promise<string> {
  const cssSource = path.join(testRoot, name);
  await fs.writeFile(cssSource, '.monaco-workbench { color: violet; }\n', 'utf8');
  return cssSource;
}

function cleanWorkbenchHtml(): string {
  return `<html>
\t<head>
\t\t${WORKBENCH_CSS_LINK}
\t</head>
</html>
`;
}

function productJson(checksum: string): string {
  return JSON.stringify(
    {
      checksums: {
        [WORKBENCH_CHECKSUM_KEY]: checksum,
      },
    },
    null,
    '\t'
  ).concat('\n');
}

function sha256Base64(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('base64').replace(/=+$/, '');
}
