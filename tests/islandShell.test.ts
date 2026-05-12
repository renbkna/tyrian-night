import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  applyIslandShell,
  readAllIslandShellStatuses,
  readIslandShellStatus,
  restoreAllIslandShells,
  restoreIslandShell,
} from '../src/islandShell';

const WORKBENCH_DIR = path.join('out', 'vs', 'code', 'electron-browser', 'workbench');
const WORKBENCH_HTML = path.join(WORKBENCH_DIR, 'workbench.html');
const PRODUCT_JSON = 'product.json';
const ISLAND_MANIFEST = path.join(WORKBENCH_DIR, 'tyrian-night.island.json');
const WORKBENCH_CHECKSUM_KEY = 'vs/code/electron-browser/workbench/workbench.html';
const WORKBENCH_CSS_LINK =
  '<link rel="stylesheet" href="../../../workbench/workbench.desktop.main.css">';
const TYRIAN_MARKER_START = '<!-- Tyrian Night Island Start -->';

let previousHome: string | undefined;
let registryHome: string;
let testRoot: string;

beforeEach(async () => {
  previousHome = process.env.HOME;
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-night-test-'));
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

test('status-all reports explicit and registered roots without probing installed VS Code paths', async () => {
  const appRoot = await createAppRoot('explicit');

  const statuses = await readAllIslandShellStatuses({
    preferredAppRoots: [appRoot],
    registryHome,
  });

  expect(statuses.map((status) => status.appRoot)).toEqual([appRoot]);
  expect(statuses[0]?.classification).toBe('clean');
});

test('status-all reports registered missing roots without mutating the registry', async () => {
  const missingAppRoot = path.join(testRoot, 'missing-root');
  const registryPath = await writeManagedRootsRegistry([missingAppRoot]);
  const before = await fs.readFile(registryPath, 'utf8');

  const statuses = await readAllIslandShellStatuses({ registryHome });

  expect(statuses).toHaveLength(1);
  expect(statuses[0]).toMatchObject({
    appRoot: missingAppRoot,
    classification: 'missing',
    managed: true,
    registered: true,
    verificationPassed: false,
    canSelfHeal: false,
  });
  expect(await fs.readFile(registryPath, 'utf8')).toBe(before);
});

test('status-all fails loudly when the managed root registry is corrupt', async () => {
  await fs.mkdir(path.join(registryHome, '.tyrian-night'), { recursive: true });
  await fs.writeFile(
    path.join(registryHome, '.tyrian-night', 'managed-app-roots.json'),
    '{ broken registry\n',
    'utf8'
  );

  await expect(readAllIslandShellStatuses({ registryHome })).rejects.toThrow(
    'Tyrian managed app roots registry is invalid JSON'
  );
});

test('status-all fails loudly when the managed root registry contains empty roots', async () => {
  await writeManagedRootsRegistry(['']);

  await expect(readAllIslandShellStatuses({ registryHome })).rejects.toThrow(
    'every app root must be a non-empty string'
  );
});

test('status-all fails loudly when the managed root registry file is empty', async () => {
  await fs.mkdir(path.join(registryHome, '.tyrian-night'), { recursive: true });
  await fs.writeFile(
    path.join(registryHome, '.tyrian-night', 'managed-app-roots.json'),
    '',
    'utf8'
  );

  await expect(readAllIslandShellStatuses({ registryHome })).rejects.toThrow(
    'Tyrian managed app roots registry is invalid JSON'
  );
});

test('status-all fails loudly when the managed root registry contains no roots', async () => {
  await fs.mkdir(path.join(registryHome, '.tyrian-night'), { recursive: true });
  await fs.writeFile(
    path.join(registryHome, '.tyrian-night', 'managed-app-roots.json'),
    JSON.stringify({ version: 1, appRoots: [] }, null, 2).concat('\n'),
    'utf8'
  );

  await expect(readAllIslandShellStatuses({ registryHome })).rejects.toThrow(
    'expected at least one app root or no registry file'
  );
});

test('clean roots with semantically correct checksum are not rewritten during restore-all', async () => {
  const appRoot = await createAppRoot('formatted-clean', {
    productJsonIndent: 2,
  });
  const productPath = path.join(appRoot, PRODUCT_JSON);
  const before = await fs.readFile(productPath, 'utf8');

  const result = await restoreAllIslandShells({
    preferredAppRoots: [appRoot],
    registryHome,
  });

  expect(result.changed).toBe(false);
  expect(result.failedAppRoots).toEqual([]);
  expect(await fs.readFile(productPath, 'utf8')).toBe(before);
  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'clean',
    canSelfHeal: false,
  });
});

test('restore-all removes registered clean roots without touching workbench files', async () => {
  const appRoot = await createAppRoot('registered-clean');
  const productPath = path.join(appRoot, PRODUCT_JSON);
  const before = await fs.readFile(productPath, 'utf8');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: green; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  await restoreIslandShell({ appRoot, registryHome });
  await fs.mkdir(path.join(registryHome, '.tyrian-night'), { recursive: true });
  await fs.writeFile(
    path.join(registryHome, '.tyrian-night', 'managed-app-roots.json'),
    JSON.stringify({ version: 1, appRoots: [appRoot] }, null, 2).concat('\n'),
    'utf8'
  );

  const result = await restoreAllIslandShells({ registryHome });

  expect(result.changed).toBe(true);
  expect(result.failedAppRoots).toEqual([]);
  expect(await fs.readFile(productPath, 'utf8')).toBe(before);
  await expect(readAllIslandShellStatuses({ registryHome })).resolves.toEqual([]);
});

test('restore cleans an explicit active root even when the managed root registry is corrupt', async () => {
  const appRoot = await createAppRoot('explicit-restore-corrupt-registry');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: rebeccapurple; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  await writeCorruptManagedRootsRegistry();

  await expect(restoreIslandShell({ appRoot, registryHome })).resolves.toMatchObject({
    changed: true,
    active: false,
  });
  await expectRestoredAppRoot(appRoot);
});

test('restore-all cleans preferred active roots even when the managed root registry is corrupt', async () => {
  const appRoot = await createAppRoot('restore-all-corrupt-registry');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: rebeccapurple; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  await writeCorruptManagedRootsRegistry();

  await expect(
    restoreAllIslandShells({ preferredAppRoots: [appRoot], registryHome })
  ).resolves.toEqual({
    changed: true,
    restoredAppRoots: [appRoot],
    failedAppRoots: [],
  });
  await expectRestoredAppRoot(appRoot);
});

test('restore-all prunes registered missing roots as an explicit cleanup action', async () => {
  const missingAppRoot = path.join(testRoot, 'missing-root');
  await writeManagedRootsRegistry([missingAppRoot]);

  const result = await restoreAllIslandShells({ registryHome });

  expect(result).toEqual({
    changed: true,
    restoredAppRoots: [],
    failedAppRoots: [],
  });
  await expect(readAllIslandShellStatuses({ registryHome })).resolves.toEqual([]);
});

test('external checksum mismatches are reported but not treated as Tyrian self-healable state', async () => {
  const appRoot = await createAppRoot('external-mismatch', {
    checksumOverride: 'not-the-real-checksum',
  });

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'checksum-mismatch',
    managed: false,
    canSelfHeal: false,
  });
});

test('restore strips active Island UI when backup evidence is broken', async () => {
  const appRoot = await createAppRoot('broken-backup');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: red; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  await fs.rm(path.join(appRoot, WORKBENCH_DIR, 'tyrian-night.workbench.backup.html'));

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'broken-backup',
    canSelfHeal: true,
  });

  await expect(restoreIslandShell({ appRoot, registryHome })).resolves.toMatchObject({
    changed: true,
    active: false,
  });
  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'clean',
    managed: false,
    registered: false,
  });
  await expect(fs.readdir(path.join(appRoot, WORKBENCH_DIR))).resolves.toEqual(['workbench.html']);
});

test('restore repairs checksum when broken sidecars mask the mismatch classification', async () => {
  const appRoot = await createAppRoot('broken-sidecar-checksum', {
    checksumOverride: 'not-the-real-checksum',
  });
  await fs.writeFile(path.join(appRoot, ISLAND_MANIFEST), '{ broken manifest\n', 'utf8');

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    active: false,
    classification: 'broken-backup',
    canSelfHeal: true,
  });

  await expect(restoreIslandShell({ appRoot, registryHome })).resolves.toMatchObject({
    changed: true,
    active: false,
  });
  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'clean',
    managed: false,
    registered: false,
  });
  await expect(fs.readdir(path.join(appRoot, WORKBENCH_DIR))).resolves.toEqual(['workbench.html']);
});

test('status treats a stale Island manifest checksum as self-healable broken state', async () => {
  const appRoot = await createAppRoot('stale-manifest-checksum');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: purple; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });

  const manifestPath = path.join(appRoot, ISLAND_MANIFEST);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.checksum = 'not-the-current-workbench-checksum';
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2).concat('\n'), 'utf8');

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    active: true,
    classification: 'broken-backup',
    canSelfHeal: true,
    issues: expect.arrayContaining([
      'Tyrian manifest checksum does not match the current workbench HTML.',
    ]),
  });

  await expect(restoreIslandShell({ appRoot, registryHome })).resolves.toMatchObject({
    changed: true,
    active: false,
  });
  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'clean',
    managed: false,
    registered: false,
  });
});

test('restore validates and uses a complete backup pair before deleting managed sidecars', async () => {
  const appRoot = await createAppRoot('valid-backup');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: blue; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });

  const backupProductPath = path.join(appRoot, WORKBENCH_DIR, 'tyrian-night.product.backup.json');
  const backupProduct = await fs.readFile(backupProductPath, 'utf8');

  await expect(restoreIslandShell({ appRoot, registryHome })).resolves.toMatchObject({
    changed: true,
    active: false,
  });
  expect(await fs.readFile(path.join(appRoot, PRODUCT_JSON), 'utf8')).toBe(backupProduct);
  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'clean',
    managed: false,
    registered: false,
  });
});

async function createAppRoot(
  name: string,
  options: {
    productJsonIndent?: number | string;
    checksumOverride?: string;
  } = {}
): Promise<string> {
  const appRoot = path.join(testRoot, name);
  const workbenchDir = path.join(appRoot, WORKBENCH_DIR);
  const html = cleanWorkbenchHtml();
  const checksum = options.checksumOverride ?? sha256Base64(html);

  await fs.mkdir(workbenchDir, { recursive: true });
  await fs.writeFile(path.join(appRoot, WORKBENCH_HTML), html, 'utf8');
  await fs.writeFile(
    path.join(appRoot, PRODUCT_JSON),
    productJson(checksum, options.productJsonIndent),
    'utf8'
  );

  return appRoot;
}

function cleanWorkbenchHtml(): string {
  return `<html>
\t<head>
\t\t${WORKBENCH_CSS_LINK}
\t</head>
</html>
`;
}

function productJson(checksum: string, indent: number | string = '\t'): string {
  return JSON.stringify(
    {
      checksums: {
        [WORKBENCH_CHECKSUM_KEY]: checksum,
      },
    },
    null,
    indent
  ).concat('\n');
}

function sha256Base64(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('base64').replace(/=+$/, '');
}

async function expectRestoredAppRoot(appRoot: string): Promise<void> {
  const html = await fs.readFile(path.join(appRoot, WORKBENCH_HTML), 'utf8');
  const product = await fs.readFile(path.join(appRoot, PRODUCT_JSON), 'utf8');

  expect(html).not.toContain(TYRIAN_MARKER_START);
  expect(JSON.parse(product).checksums[WORKBENCH_CHECKSUM_KEY]).toBe(sha256Base64(html));
  await expect(fs.readdir(path.join(appRoot, WORKBENCH_DIR))).resolves.toEqual(['workbench.html']);
}

async function writeManagedRootsRegistry(appRoots: string[]): Promise<string> {
  const registryPath = path.join(registryHome, '.tyrian-night', 'managed-app-roots.json');

  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    JSON.stringify({ version: 1, appRoots }, null, 2).concat('\n'),
    'utf8'
  );

  return registryPath;
}

async function writeCorruptManagedRootsRegistry(): Promise<void> {
  await fs.mkdir(path.join(registryHome, '.tyrian-night'), { recursive: true });
  await fs.writeFile(
    path.join(registryHome, '.tyrian-night', 'managed-app-roots.json'),
    '{ broken registry\n',
    'utf8'
  );
}
