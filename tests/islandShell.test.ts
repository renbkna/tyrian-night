import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  applyIslandShell,
  readAllIslandShellStatuses,
  readIslandShellApplyReadiness,
  readIslandShellStatus,
  restoreAllIslandShells,
  restoreIslandShell,
} from '../apps/vscode/src/islandShell';
import {
  BACKUP_HTML_FILE_NAME,
  BACKUP_PRODUCT_FILE_NAME,
  ISLAND_CSS_FILE_NAME,
  ISLAND_MANIFEST_FILE_NAME,
  TYRIAN_MARKER_START,
  WORKBENCH_CHECKSUM_KEY,
  WORKBENCH_CSS_LINK,
  buildIslandPatchPaths,
  buildManagedRootsRegistryPath,
} from '../apps/vscode/src/islandPatchContract';

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
    canSelfHeal: true,
  });
  expect(await fs.readFile(registryPath, 'utf8')).toBe(before);
});

test('status-all fails loudly when the managed root registry is corrupt', async () => {
  await writeManagedRootsRegistryContent('{ broken registry\n');

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
  await writeManagedRootsRegistryContent('');

  await expect(readAllIslandShellStatuses({ registryHome })).rejects.toThrow(
    'Tyrian managed app roots registry is invalid JSON'
  );
});

test('status-all fails loudly when the managed root registry contains no roots', async () => {
  await writeManagedRootsRegistryContent(
    JSON.stringify({ version: 1, appRoots: [] }, null, 2).concat('\n')
  );

  await expect(readAllIslandShellStatuses({ registryHome })).rejects.toThrow(
    'expected at least one app root or no registry file'
  );
});

test('clean roots with semantically correct checksum are not rewritten during restore-all', async () => {
  const appRoot = await createAppRoot('formatted-clean', {
    productJsonIndent: 2,
  });
  const productPath = buildIslandPatchPaths(appRoot).productJsonPath;
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
  const productPath = buildIslandPatchPaths(appRoot).productJsonPath;
  const before = await fs.readFile(productPath, 'utf8');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: green; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  await restoreIslandShell({ appRoot, registryHome });
  const registryPath = buildManagedRootsRegistryPath(registryHome);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
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
  await fs.rm(buildIslandPatchPaths(appRoot).backupHtmlPath);

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
  await expectOnlyWorkbenchHtmlSidecarRemains(appRoot);
});

test('restore repairs checksum when broken sidecars mask the mismatch classification', async () => {
  const appRoot = await createAppRoot('broken-sidecar-checksum', {
    checksumOverride: 'not-the-real-checksum',
  });
  await fs.writeFile(buildIslandPatchPaths(appRoot).manifestPath, '{ broken manifest\n', 'utf8');

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
  await expectOnlyWorkbenchHtmlSidecarRemains(appRoot);
});

test('status treats a stale Island manifest checksum as self-healable broken state', async () => {
  const appRoot = await createAppRoot('stale-manifest-checksum');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: purple; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });

  const manifestPath = buildIslandPatchPaths(appRoot).manifestPath;
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.patchedWorkbenchChecksum = 'not-the-current-workbench-checksum';
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

test('apply writes a v2 manifest receipt that identifies the owned patch surface', async () => {
  const appRoot = await createAppRoot('manifest-v2');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: greenyellow; }\n', 'utf8');

  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });

  const manifest = JSON.parse(
    await fs.readFile(buildIslandPatchPaths(appRoot).manifestPath, 'utf8')
  ) as Record<string, unknown>;

  expect(manifest).toMatchObject({
    version: 2,
    themeVersion: 'test',
    appRoot,
    patchStrategy: 'stylesheet-link-v1',
    ownedFiles: {
      stylesheet: ISLAND_CSS_FILE_NAME,
      manifest: ISLAND_MANIFEST_FILE_NAME,
      workbenchBackup: BACKUP_HTML_FILE_NAME,
      productBackup: BACKUP_PRODUCT_FILE_NAME,
    },
  });
  expect(manifest).toHaveProperty('upstreamWorkbenchChecksum');
  expect(manifest).toHaveProperty('upstreamProductChecksum');
  expect(manifest).toHaveProperty('cssChecksum');
  expect(manifest).toHaveProperty('patchedWorkbenchChecksum');
  expect(manifest).toHaveProperty('patchedProductChecksum');
});

test('restore validates and uses a complete backup pair before deleting managed sidecars', async () => {
  const appRoot = await createAppRoot('valid-backup');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: blue; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });

  const backupProductPath = buildIslandPatchPaths(appRoot).backupProductJsonPath;
  const backupProduct = await fs.readFile(backupProductPath, 'utf8');

  await expect(restoreIslandShell({ appRoot, registryHome })).resolves.toMatchObject({
    changed: true,
    active: false,
  });
  expect(await fs.readFile(buildIslandPatchPaths(appRoot).productJsonPath, 'utf8')).toBe(
    backupProduct
  );
  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'clean',
    managed: false,
    registered: false,
  });
});

test('restore refuses incomplete manifest ownership proof before trusting backup sidecars', async () => {
  const appRoot = await createAppRoot('incomplete-restore-proof');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: blue; }\n', 'utf8');
  const cleanHtml = await fs.readFile(buildIslandPatchPaths(appRoot).workbenchHtmlPath, 'utf8');

  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });

  const { backupHtmlPath, backupProductJsonPath, manifestPath } = buildIslandPatchPaths(appRoot);
  const untrustedBackupHtml = cleanWorkbenchHtml().replace(
    '</html>',
    '<body>untrusted</body>\n</html>'
  );
  await fs.writeFile(backupHtmlPath, untrustedBackupHtml, 'utf8');
  await fs.writeFile(backupProductJsonPath, productJson(sha256Base64(untrustedBackupHtml)), 'utf8');
  await fs.writeFile(
    manifestPath,
    JSON.stringify({ version: 1, extensionVersion: 'old' }, null, 2).concat('\n'),
    'utf8'
  );

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'broken-backup',
    canSelfHeal: true,
  });

  await expect(restoreIslandShell({ appRoot, registryHome })).resolves.toMatchObject({
    changed: true,
    active: false,
  });
  expect(await fs.readFile(buildIslandPatchPaths(appRoot).workbenchHtmlPath, 'utf8')).toBe(
    cleanHtml
  );
  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'clean',
    managed: false,
    registered: false,
  });
});

test('apply readiness reports permission-required without mutating a read-only app root', async () => {
  const appRoot = await createAppRoot('readonly-apply-root');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: hotpink; }\n', 'utf8');
  const {
    productJsonPath: productPath,
    workbenchDirPath: workbenchDir,
    workbenchHtmlPath: workbenchPath,
  } = buildIslandPatchPaths(appRoot);
  const beforeHtml = await fs.readFile(workbenchPath, 'utf8');
  const beforeProduct = await fs.readFile(productPath, 'utf8');

  try {
    await fs.chmod(workbenchDir, 0o555);
    await fs.chmod(workbenchPath, 0o444);
    await fs.chmod(productPath, 0o444);

    const readiness = await readIslandShellApplyReadiness({
      appRoot,
      cssSourcePath: cssSource,
      themeVersion: 'test',
      registryHome,
    });

    expect(readiness).toMatchObject({
      kind: 'permission-required',
      changed: true,
      writeAccess: {
        writable: false,
      },
    });
    expect(await fs.readFile(workbenchPath, 'utf8')).toBe(beforeHtml);
    expect(await fs.readFile(productPath, 'utf8')).toBe(beforeProduct);
    await expectOnlyWorkbenchHtmlSidecarRemains(appRoot);
  } finally {
    await fs.chmod(workbenchDir, 0o755);
    await fs.chmod(workbenchPath, 0o644);
    await fs.chmod(productPath, 0o644);
  }
});

test('apply readiness reports already-current after a verified apply', async () => {
  const appRoot = await createAppRoot('already-current-readiness');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: cyan; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });

  await expect(
    readIslandShellApplyReadiness({
      appRoot,
      cssSourcePath: cssSource,
      themeVersion: 'test',
      registryHome,
    })
  ).resolves.toMatchObject({
    kind: 'ready',
    changed: false,
    status: {
      classification: 'patched',
    },
  });
});

test('apply preflights corrupt managed root registry before writing app files', async () => {
  const appRoot = await createAppRoot('corrupt-registry-apply');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: orange; }\n', 'utf8');
  await writeCorruptManagedRootsRegistry();

  await expect(
    applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome })
  ).rejects.toThrow('Tyrian managed app roots registry is invalid JSON');
  await expectRestoredAppRoot(appRoot);
});

async function createAppRoot(
  name: string,
  options: {
    productJsonIndent?: number | string;
    checksumOverride?: string;
  } = {}
): Promise<string> {
  const appRoot = path.join(testRoot, name);
  const { productJsonPath, workbenchDirPath, workbenchHtmlPath } = buildIslandPatchPaths(appRoot);
  const html = cleanWorkbenchHtml();
  const checksum = options.checksumOverride ?? sha256Base64(html);

  await fs.mkdir(workbenchDirPath, { recursive: true });
  await fs.writeFile(workbenchHtmlPath, html, 'utf8');
  await fs.writeFile(productJsonPath, productJson(checksum, options.productJsonIndent), 'utf8');

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
  const { productJsonPath, workbenchHtmlPath } = buildIslandPatchPaths(appRoot);
  const html = await fs.readFile(workbenchHtmlPath, 'utf8');
  const product = await fs.readFile(productJsonPath, 'utf8');

  expect(html).not.toContain(TYRIAN_MARKER_START);
  expect(JSON.parse(product).checksums[WORKBENCH_CHECKSUM_KEY]).toBe(sha256Base64(html));
  await expectOnlyWorkbenchHtmlSidecarRemains(appRoot);
}

async function writeManagedRootsRegistry(appRoots: string[]): Promise<string> {
  const registryPath = buildManagedRootsRegistryPath(registryHome);

  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    JSON.stringify({ version: 1, appRoots }, null, 2).concat('\n'),
    'utf8'
  );

  return registryPath;
}

async function writeCorruptManagedRootsRegistry(): Promise<void> {
  await writeManagedRootsRegistryContent('{ broken registry\n');
}

async function writeManagedRootsRegistryContent(content: string): Promise<void> {
  const registryPath = buildManagedRootsRegistryPath(registryHome);

  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, content, 'utf8');
}

async function expectOnlyWorkbenchHtmlSidecarRemains(appRoot: string): Promise<void> {
  const paths = buildIslandPatchPaths(appRoot);

  await expect(fs.readdir(paths.workbenchDirPath)).resolves.toEqual([
    path.basename(paths.workbenchHtmlPath),
  ]);
}
