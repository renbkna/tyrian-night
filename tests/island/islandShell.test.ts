import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  applyIslandShell,
  readIslandShellInventory,
  readIslandShellApplyReadiness,
  readIslandShellStatus,
  restoreAllIslandShells,
  restoreIslandShell,
} from '../../apps/vscode/src/islandShell.js';
import {
  BACKUP_HTML_FILE_NAME,
  BACKUP_PRODUCT_FILE_NAME,
  ISLAND_CSS_FILE_NAME,
  ISLAND_MANIFEST_FILE_NAME,
  TYRIAN_MARKER_END,
  TYRIAN_MARKER_START,
  WORKBENCH_CHECKSUM_KEY,
  WORKBENCH_CSS_LINK,
  buildIslandLockPath,
  buildIslandPatchPaths,
  buildManagedRootRecordPath,
  buildManagedRootsDirectoryPath,
} from '../../apps/vscode/src/islandPatchContract.js';
import {
  describeIslandShellFailure,
  type IslandShellStatus,
} from '../../apps/vscode/src/islandShellContract.js';
import {
  publishManagedRootRecord,
  readManagedAppRootRegistration,
} from '../../apps/vscode/src/islandRegistry.js';
import { applyFileMutations } from '../../apps/vscode/src/islandFileSystem.js';
import {
  buildIslandApplyPlan,
  buildRestoreMutations,
  buildRestorePlan,
  inspectIslandRoot,
} from '../../apps/vscode/src/islandPatchPlan.js';

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

test('status-all reports explicit roots without initializing registry state', async () => {
  const appRoot = await createAppRoot('explicit');

  const statuses = await readStatuses({
    preferredAppRoots: [appRoot],
    registryHome,
  });

  expect(statuses.map((status) => status.appRoot)).toEqual([appRoot]);
  expect(statuses[0]?.classification).toBe('clean');
  await expect(fs.stat(buildManagedRootsDirectoryPath(registryHome))).rejects.toThrow();
});

test('Doctor inventory reports corrupt registry entries without mutating them', async () => {
  const directoryPath = buildManagedRootsDirectoryPath(registryHome);
  const corruptPath = path.join(directoryPath, `${'0'.repeat(64)}.json`);
  const unreadablePath = path.join(directoryPath, `${'1'.repeat(64)}.json`);
  const symlinkPath = path.join(directoryPath, 'bad-link');
  const directoryEntryPath = path.join(directoryPath, 'bad-directory');
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(corruptPath, '{ broken\n', 'utf8');
  await fs.writeFile(unreadablePath, '{ unreadable\n', 'utf8');
  await fs.chmod(unreadablePath, 0o000);
  await fs.symlink(corruptPath, symlinkPath);
  await fs.mkdir(directoryEntryPath);
  const entriesBefore = await fs.readdir(directoryPath);

  try {
    const inventory = await readIslandShellInventory({ registryHome });

    expect(inventory).toMatchObject({
      statuses: [],
    });
    expect(inventory.registryDiagnostics.length).toBeGreaterThanOrEqual(4);
    expect(await fs.readdir(directoryPath)).toEqual(entriesBefore);
    expect(await fs.readFile(corruptPath, 'utf8')).toBe('{ broken\n');
    expect((await fs.lstat(symlinkPath)).isSymbolicLink()).toBe(true);
  } finally {
    await fs.chmod(unreadablePath, 0o644);
  }
});

test('Restore quarantines a hash-named corrupt registry symlink without following it', async () => {
  const missingAppRoot = path.join(testRoot, 'symlinked-hash-record-root');
  const recordPath = buildManagedRootRecordPath(missingAppRoot, registryHome);
  const outsideTargetPath = path.join(testRoot, 'hash-record-outside-target');
  const outsideContent = 'outside hash record target\n';
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(outsideTargetPath, outsideContent, 'utf8');
  await fs.symlink(outsideTargetPath, recordPath);

  const result = await restoreAllIslandShells({ registryHome });

  expect(result.changed).toBe(true);
  expect(result.failedAppRoots).toEqual([]);
  expect(result.quarantinedRecords).toHaveLength(1);
  const quarantinePath = result.quarantinedRecords[0]!;
  expect(quarantinePath).toContain('quarantined-managed-app-roots');
  await expect(fs.lstat(recordPath)).rejects.toThrow();
  expect(await fs.readFile(outsideTargetPath, 'utf8')).toBe(outsideContent);
  expect((await fs.lstat(outsideTargetPath)).isFile()).toBe(true);
  expect((await fs.lstat(quarantinePath)).isSymbolicLink()).toBe(true);
  expect(await fs.readlink(quarantinePath)).toBe(outsideTargetPath);
});

test('Restore quarantines an invalid-name registry symlink without following it', async () => {
  const registryDirectory = buildManagedRootsDirectoryPath(registryHome);
  const recordPath = path.join(registryDirectory, 'invalid-registry-symlink');
  const outsideTargetPath = path.join(testRoot, 'invalid-name-outside-target');
  const outsideContent = 'outside invalid-name target\n';
  await fs.mkdir(registryDirectory, { recursive: true });
  await fs.writeFile(outsideTargetPath, outsideContent, 'utf8');
  await fs.symlink(outsideTargetPath, recordPath);

  const result = await restoreAllIslandShells({ registryHome });

  expect(result.changed).toBe(true);
  expect(result.failedAppRoots).toEqual([]);
  expect(result.quarantinedRecords).toHaveLength(1);
  const quarantinePath = result.quarantinedRecords[0]!;
  expect(quarantinePath).toContain('quarantined-managed-app-roots');
  await expect(fs.lstat(recordPath)).rejects.toThrow();
  expect(await fs.readFile(outsideTargetPath, 'utf8')).toBe(outsideContent);
  expect((await fs.lstat(outsideTargetPath)).isFile()).toBe(true);
  expect((await fs.lstat(quarantinePath)).isSymbolicLink()).toBe(true);
  expect(await fs.readlink(quarantinePath)).toBe(outsideTargetPath);
});

test('status-all reports registered missing roots without mutating the registry', async () => {
  const missingAppRoot = path.join(testRoot, 'missing-root');
  const recordPath = await writeManagedRootRecord(missingAppRoot);
  const before = await fs.readFile(recordPath, 'utf8');

  const statuses = await readStatuses({ registryHome });

  expect(statuses).toHaveLength(1);
  expect(statuses[0]).toMatchObject({
    appRoot: missingAppRoot,
    classification: 'missing',
    managed: false,
    registered: true,
    verificationPassed: false,
  });
  expect(await fs.readFile(recordPath, 'utf8')).toBe(before);
});

// Sixteen durable apply/restore lifecycles may outlast the default five-second
// test budget; each contended lock alone permits up to ten seconds to acquire.
test('concurrent app roots register and unregister without overwriting each other', async () => {
  const appRoots = await Promise.all(
    Array.from({ length: 16 }, (_, index) => createAppRoot(`concurrent-${index}`))
  );
  const cssSource = path.join(testRoot, 'concurrent-theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: cyan; }\n', 'utf8');

  await Promise.all(
    appRoots.map((appRoot) =>
      applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome })
    )
  );

  expect((await readStatuses({ registryHome })).map(({ appRoot }) => appRoot)).toEqual(
    [...appRoots].sort((left, right) => left.localeCompare(right))
  );

  await Promise.all(appRoots.map((appRoot) => restoreIslandShell({ appRoot, registryHome })));

  expect(await readStatuses({ registryHome })).toHaveLength(appRoots.length);
  expect(await readStatuses({ registryHome })).toEqual(
    expect.arrayContaining(
      appRoots.map((appRoot) =>
        expect.objectContaining({ appRoot, registrationState: 'valid', desiredCssFile: null })
      )
    )
  );
  expect((await fs.stat(buildManagedRootsDirectoryPath(registryHome))).isDirectory()).toBe(true);
}, 30_000);

test('registry enumeration observes stable snapshots during concurrent publication', async () => {
  const appRoots = await Promise.all(
    Array.from({ length: 6 }, (_, index) => createAppRoot(`snapshot-${index}`))
  );
  const cssSource = path.join(testRoot, 'snapshot.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: cyan; }\n', 'utf8');
  await readStatuses({ registryHome });

  const publications = appRoots.map((appRoot) =>
    applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome })
  );
  const snapshots = await Promise.all(
    Array.from({ length: 12 }, () => readStatuses({ registryHome }))
  );
  await Promise.all(publications);

  for (const statuses of snapshots) {
    expect(new Set(statuses.map(({ appRoot }) => appRoot)).size).toBe(statuses.length);
    expect(statuses.every(({ registrationState }) => registrationState === 'valid')).toBe(true);
  }
});

test('physical app-root aliases share one record and manifest authority', async () => {
  const appRoot = await createAppRoot('physical-root');
  const aliasRoot = path.join(testRoot, 'root-alias');
  const firstCss = path.join(testRoot, 'alias-first.css');
  const secondCss = path.join(testRoot, 'alias-second.css');
  await fs.symlink(appRoot, aliasRoot, 'dir');
  await fs.writeFile(firstCss, '.monaco-workbench { color: red; }\n', 'utf8');
  await fs.writeFile(secondCss, '.monaco-workbench { color: blue; }\n', 'utf8');

  await applyIslandShell({ appRoot, cssSourcePath: firstCss, themeVersion: 'first', registryHome });
  await applyIslandShell({
    appRoot: aliasRoot,
    cssSourcePath: secondCss,
    themeVersion: 'second',
    registryHome,
  });

  const status = await readIslandShellStatus({ appRoot: aliasRoot, registryHome });
  expect(status.appRoot).toBe(appRoot);
  expect(status.classification).toBe('patched');
  expect(await fs.readdir(buildManagedRootsDirectoryPath(registryHome))).toEqual([
    path.basename(buildManagedRootRecordPath(appRoot, registryHome)),
  ]);
  expect(
    JSON.parse(await fs.readFile(buildIslandPatchPaths(appRoot).manifestPath, 'utf8')).appRoot
  ).toBe(appRoot);
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

  expect(result.changed).toBe(true);
  expect(result).toMatchObject({
    desiredStateChanged: true,
    registryChanged: true,
    physicalChanged: false,
    externalDrift: false,
    incompleteRecovery: false,
  });
  expect(result.failedAppRoots).toEqual([]);
  expect(await fs.readFile(productPath, 'utf8')).toBe(before);
  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'clean',
    registrationState: 'valid',
    desiredCssFile: null,
  });
});

test('restore-all retains a current disabled desired record without touching workbench files', async () => {
  const appRoot = await createAppRoot('registered-clean');
  const productPath = buildIslandPatchPaths(appRoot).productJsonPath;
  const before = await fs.readFile(productPath, 'utf8');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: green; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  await restoreIslandShell({ appRoot, registryHome });
  await writeManagedRootRecord(appRoot);

  const result = await restoreAllIslandShells({ registryHome });

  expect(result.changed).toBe(false);
  expect(result).toMatchObject({
    desiredStateChanged: false,
    registryChanged: false,
    physicalChanged: false,
  });
  expect(result.failedAppRoots).toEqual([]);
  expect(await fs.readFile(productPath, 'utf8')).toBe(before);
  await expect(readStatuses({ registryHome })).resolves.toMatchObject([
    { appRoot, registrationState: 'valid', desiredCssFile: null, classification: 'clean' },
  ]);
});

test('restore cleans an explicit active root even when the managed root registry is corrupt', async () => {
  const appRoot = await createAppRoot('explicit-restore-corrupt-registry');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: rebeccapurple; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  await writeCorruptManagedRootRecord();

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
  await writeCorruptManagedRootRecord();

  const result = await restoreAllIslandShells({ preferredAppRoots: [appRoot], registryHome });

  expect(result).toMatchObject({
    changed: true,
    restoredAppRoots: [appRoot],
    failedAppRoots: [],
    quarantinedRecords: [expect.stringContaining('quarantined-managed-app-roots')],
  });
  expect(result.enumerationFailure).toBeUndefined();
  await expectRestoredAppRoot(appRoot);
  await expect(readStatuses({ registryHome })).resolves.toMatchObject([
    { appRoot, registrationState: 'valid', desiredCssFile: null, classification: 'clean' },
  ]);
});

test('quarantining unrelated corrupt data reports changed for a clean preferred root', async () => {
  const appRoot = await createAppRoot('clean-preferred-quarantine');
  await writeCorruptManagedRootRecord();

  const result = await restoreAllIslandShells({ preferredAppRoots: [appRoot], registryHome });

  expect(result).toMatchObject({
    changed: true,
    failedAppRoots: [],
    quarantinedRecords: [expect.stringContaining('quarantined-managed-app-roots')],
  });
});

test('registry mutation facts survive a later enumeration failure', async () => {
  const appRoot = await createAppRoot('quarantine-before-enumeration-failure');
  await restoreIslandShell({ appRoot, registryHome });
  await writeCorruptManagedRootRecord();
  await fs.mkdir(path.join(buildManagedRootsDirectoryPath(registryHome), 'zz-invalid-directory'));

  const result = await restoreAllIslandShells({ preferredAppRoots: [appRoot], registryHome });

  expect(result).toMatchObject({
    changed: true,
    failedAppRoots: [],
    quarantinedRecords: [expect.stringContaining('quarantined-managed-app-roots')],
    enumerationFailure: {
      code: 'blocked',
      reason: expect.stringContaining('zz-invalid-directory'),
    },
  });
});

test('registry publication rejects invalid desired state before creating persistence', async () => {
  const appRoot = path.join(testRoot, 'invalid-desired-owner');
  await expect(
    publishManagedRootRecord(appRoot, '../escape.css', { registryHome })
  ).rejects.toThrow('desiredCssFile must be null or a CSS asset name');
  await expect(fs.stat(buildManagedRootsDirectoryPath(registryHome))).rejects.toThrow();
});

test('a desired-state record with fields outside its format is corrupt', async () => {
  const appRoot = await createAppRoot('record-extra-field');
  const recordPath = buildManagedRootRecordPath(appRoot, registryHome);
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(
    recordPath,
    `${JSON.stringify({ version: 2, appRoot, desiredCssFile: 'theme.css' })}\n`,
    'utf8'
  );

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    registrationState: 'corrupt',
    desiredCssFile: undefined,
  });
});

test('restore-all prunes registered missing roots as an explicit cleanup action', async () => {
  const missingAppRoot = path.join(testRoot, 'missing-root');
  await writeManagedRootRecord(missingAppRoot);

  const result = await restoreAllIslandShells({ registryHome });

  expect(result).toEqual({
    changed: true,
    desiredStateChanged: false,
    registryChanged: true,
    physicalChanged: false,
    externalDrift: false,
    incompleteRecovery: false,
    restoredAppRoots: [],
    failedAppRoots: [],
    quarantinedRecords: [],
  });
  await expect(readStatuses({ registryHome })).resolves.toEqual([]);
});

test('missing-root cleanup preserves desired state for an existing incomplete installation', async () => {
  const appRoot = path.join(testRoot, 'incomplete-existing-root');
  await fs.mkdir(appRoot);
  const recordPath = await writeManagedRootRecord(appRoot);
  const originalRecord = await fs.readFile(recordPath, 'utf8');
  const result = await restoreAllIslandShells({ registryHome });
  expect(result.failedAppRoots).toEqual([
    expect.objectContaining({ appRoot, reason: expect.stringContaining('existing app root') }),
  ]);
  expect(await fs.readFile(recordPath, 'utf8')).toBe(originalRecord);
});

test('Restore quarantines an identifiable corrupt record for a missing root by generation', async () => {
  const missingAppRoot = path.join(testRoot, 'missing-corrupt-root');
  const recordPath = buildManagedRootRecordPath(missingAppRoot, registryHome);
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(
    recordPath,
    JSON.stringify({ appRoot: missingAppRoot, desiredCssFile: 42 }).concat('\n'),
    'utf8'
  );

  const result = await restoreAllIslandShells({ registryHome });

  expect(result).toMatchObject({
    changed: true,
    failedAppRoots: [],
    quarantinedRecords: [expect.stringContaining('quarantined-managed-app-roots')],
  });
  await expect(fs.stat(recordPath)).rejects.toThrow();
});

test('external checksum mismatches are reported but not treated as Tyrian self-healable state', async () => {
  const appRoot = await createAppRoot('external-mismatch', {
    checksumOverride: 'not-the-real-checksum',
  });

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'checksum-mismatch',
    managed: false,
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
  });

  await expect(restoreIslandShell({ appRoot, registryHome })).resolves.toMatchObject({
    changed: true,
    active: false,
  });
  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'clean',
    managed: false,
    registered: true,
    registrationState: 'valid',
    desiredCssFile: null,
  });
  await expectOnlyWorkbenchHtmlSidecarRemains(appRoot);
});

test('a patched root without its desired-state record is classified as repair state', async () => {
  const appRoot = await createAppRoot('missing-desired-record');
  const cssSource = path.join(testRoot, 'missing-record.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: cyan; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  await fs.rm(buildManagedRootRecordPath(appRoot, registryHome));

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    active: true,
    registered: false,
    desiredCssFile: undefined,
    classification: 'broken-backup',
    verificationPassed: false,
    issues: expect.arrayContaining([
      'Tyrian patch evidence exists without its required desired-state record.',
    ]),
  });
});

test('direct restore replaces a corrupt owned record with durable disabled state', async () => {
  const appRoot = await createAppRoot('corrupt-own-record');
  const cssSource = path.join(testRoot, 'corrupt-own.css');
  const recordPath = buildManagedRootRecordPath(appRoot, registryHome);
  await fs.writeFile(cssSource, '.monaco-workbench { color: cyan; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  await fs.writeFile(
    recordPath,
    JSON.stringify({ appRoot, desiredCssFile: 42 }, null, 2).concat('\n'),
    'utf8'
  );

  await expect(readIslandShellInventory({ registryHome })).resolves.toMatchObject({
    statuses: [{ appRoot, registrationState: 'corrupt', classification: 'broken-backup' }],
    registryDiagnostics: [
      expect.stringContaining('desiredCssFile must be null or a CSS asset name'),
    ],
  });

  await expect(restoreIslandShell({ appRoot, registryHome })).resolves.toMatchObject({
    changed: true,
    active: false,
  });
  await expect(fs.readFile(recordPath, 'utf8').then(JSON.parse)).resolves.toEqual({
    appRoot,
    desiredCssFile: null,
  });
  await expectRestoredAppRoot(appRoot);
});

test('restore removes malformed Island blocks without deleting proof before verification', async () => {
  for (const [name, missingMarker] of [
    ['missing-start', TYRIAN_MARKER_START],
    ['missing-end', TYRIAN_MARKER_END],
  ] as const) {
    const appRoot = await createAppRoot(name);
    const cssSource = path.join(testRoot, `${name}.css`);
    await fs.writeFile(cssSource, '.monaco-workbench { color: cyan; }\n', 'utf8');
    await applyIslandShell({
      appRoot,
      cssSourcePath: cssSource,
      themeVersion: 'test',
      registryHome,
    });

    const { productJsonPath, workbenchHtmlPath } = buildIslandPatchPaths(appRoot);
    const malformedHtml = (await fs.readFile(workbenchHtmlPath, 'utf8')).replace(missingMarker, '');
    await fs.writeFile(workbenchHtmlPath, malformedHtml, 'utf8');
    await fs.writeFile(productJsonPath, productJson(sha256Base64(malformedHtml)), 'utf8');

    await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
      active: true,
      classification: 'broken-backup',
      restoreProof: 'strip-tyrian-block',
    });
    await expect(restoreIslandShell({ appRoot, registryHome })).resolves.toMatchObject({
      active: false,
      changed: true,
    });
    const restoredHtml = await fs.readFile(workbenchHtmlPath, 'utf8');
    expect(restoredHtml).not.toContain(TYRIAN_MARKER_START);
    expect(restoredHtml).not.toContain(TYRIAN_MARKER_END);
    expect(restoredHtml).not.toContain(ISLAND_CSS_FILE_NAME);
    await expectRestoredAppRoot(appRoot);
  }
});

for (const [name, replacement] of [
  [
    'query-and-extra-attributes',
    '<link data-owner="external" href="./tyrian-night.island.css?cache=2#fragment" media="all">',
  ],
  ['plain-href', '<link href="tyrian-night.island.css" rel="preload">'],
  [
    'absolute-href',
    '<link crossorigin href="file:///tmp/tyrian-night.island.css?cache=3" data-extra="yes">',
  ],
  [
    'inline-link',
    '<span>foreign prefix</span><link href="./tyrian-night.island.css#inline" data-extra="yes">',
  ],
  [
    'unquoted-href',
    '<link data-extra=yes href=./tyrian-night.island.css?cache=4#fragment media=all>',
  ],
] as const) {
  test(`restore owns a ${name} link targeting the Tyrian stylesheet filename`, async () => {
    const appRoot = await createAppRoot(name);
    const cssSource = path.join(testRoot, `${name}.css`);
    await fs.writeFile(cssSource, '.monaco-workbench { color: cyan; }\n', 'utf8');
    await applyIslandShell({
      appRoot,
      cssSourcePath: cssSource,
      themeVersion: 'test',
      registryHome,
    });
    const { productJsonPath, workbenchHtmlPath } = buildIslandPatchPaths(appRoot);
    const mutatedHtml = (await fs.readFile(workbenchHtmlPath, 'utf8')).replace(
      /<link rel="stylesheet" href="\.\/tyrian-night\.island\.css\?v=[^"]+">/u,
      replacement
    );
    await fs.writeFile(workbenchHtmlPath, mutatedHtml, 'utf8');
    await fs.writeFile(productJsonPath, productJson(sha256Base64(mutatedHtml)), 'utf8');

    try {
      await restoreIslandShell({ appRoot, registryHome });
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const restoredHtml = await fs.readFile(workbenchHtmlPath, 'utf8');
    expect(restoredHtml).not.toContain(ISLAND_CSS_FILE_NAME);
    expect(restoredHtml).not.toContain(TYRIAN_MARKER_START);
    expect(restoredHtml).not.toContain(TYRIAN_MARKER_END);
  });
}

test('restore repairs checksum when broken sidecars mask the mismatch classification', async () => {
  const appRoot = await createAppRoot('broken-sidecar-checksum', {
    checksumOverride: 'not-the-real-checksum',
  });
  await fs.writeFile(buildIslandPatchPaths(appRoot).manifestPath, '{ broken manifest\n', 'utf8');

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    active: false,
    classification: 'broken-backup',
  });

  await expect(restoreIslandShell({ appRoot, registryHome })).resolves.toMatchObject({
    changed: true,
    active: false,
  });
  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'clean',
    managed: false,
    registered: true,
    desiredCssFile: null,
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
    registered: true,
    desiredCssFile: null,
  });
});

test('restore preserves post-apply workbench edits when the manifest no longer proves the patch', async () => {
  const appRoot = await createAppRoot('post-apply-workbench-edit');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: purple; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });

  const { productJsonPath, workbenchHtmlPath } = buildIslandPatchPaths(appRoot);
  const editedHtml = (await fs.readFile(workbenchHtmlPath, 'utf8')).replace(
    '</html>',
    '\t<body>external workbench edit</body>\n</html>'
  );
  await fs.writeFile(workbenchHtmlPath, editedHtml, 'utf8');
  await fs.writeFile(productJsonPath, productJson(sha256Base64(editedHtml)), 'utf8');

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'broken-backup',
    restoreProof: 'strip-tyrian-block',
  });

  await restoreIslandShell({ appRoot, registryHome });

  const restoredHtml = await fs.readFile(workbenchHtmlPath, 'utf8');
  expect(restoredHtml).toContain('external workbench edit');
  expect(restoredHtml).not.toContain(TYRIAN_MARKER_START);
  await expectRestoredAppRoot(appRoot);
});

test('restore rejects a replaced backup pair whose hashes do not match the manifest', async () => {
  const appRoot = await createAppRoot('replaced-backup-pair');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: blue; }\n', 'utf8');
  const cleanHtml = await fs.readFile(buildIslandPatchPaths(appRoot).workbenchHtmlPath, 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });

  const { backupHtmlPath, backupProductJsonPath, workbenchHtmlPath } =
    buildIslandPatchPaths(appRoot);
  const replacedBackupHtml = cleanWorkbenchHtml().replace(
    '</html>',
    '\t<body>replaced backup</body>\n</html>'
  );
  await fs.writeFile(backupHtmlPath, replacedBackupHtml, 'utf8');
  await fs.writeFile(backupProductJsonPath, productJson(sha256Base64(replacedBackupHtml)), 'utf8');

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'broken-backup',
    restoreProof: 'strip-tyrian-block',
  });

  await restoreIslandShell({ appRoot, registryHome });

  expect(await fs.readFile(workbenchHtmlPath, 'utf8')).toBe(cleanHtml);
  expect(await fs.readFile(workbenchHtmlPath, 'utf8')).not.toContain('replaced backup');
  await expectRestoredAppRoot(appRoot);
});

test('status rejects CSS and patched product drift from the manifest receipt', async () => {
  const cssDriftRoot = await createAppRoot('css-drift');
  const productDriftRoot = await createAppRoot('product-drift');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: cyan; }\n', 'utf8');
  await applyIslandShell({
    appRoot: cssDriftRoot,
    cssSourcePath: cssSource,
    themeVersion: 'test',
    registryHome,
  });
  await applyIslandShell({
    appRoot: productDriftRoot,
    cssSourcePath: cssSource,
    themeVersion: 'test',
    registryHome,
  });

  await fs.writeFile(
    buildIslandPatchPaths(cssDriftRoot).islandCssPath,
    '.monaco-workbench { color: magenta; }\n',
    'utf8'
  );
  const productPath = buildIslandPatchPaths(productDriftRoot).productJsonPath;
  const product = JSON.parse(await fs.readFile(productPath, 'utf8')) as Record<string, unknown>;
  product.name = 'externally changed product';
  await fs.writeFile(productPath, JSON.stringify(product, null, '\t').concat('\n'), 'utf8');

  await expect(
    readIslandShellStatus({ appRoot: cssDriftRoot, registryHome })
  ).resolves.toMatchObject({
    classification: 'broken-backup',
    restoreProof: 'strip-tyrian-block',
    issues: expect.arrayContaining(['Tyrian manifest checksum does not match the injected CSS.']),
  });
  await expect(
    readIslandShellStatus({ appRoot: productDriftRoot, registryHome })
  ).resolves.toMatchObject({
    classification: 'broken-backup',
    restoreProof: 'strip-tyrian-block',
    issues: expect.arrayContaining([
      'Tyrian manifest checksum does not match the current product.json.',
    ]),
  });
});

test('status rejects drift between desired style and the physical manifest receipt', async () => {
  const appRoot = await createAppRoot('desired-style-drift');
  const cssSource = path.join(testRoot, 'desired-first.css');
  const recordPath = buildManagedRootRecordPath(appRoot, registryHome);
  await fs.writeFile(cssSource, '.monaco-workbench { color: cyan; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  await fs.writeFile(
    recordPath,
    JSON.stringify({ appRoot, desiredCssFile: 'desired-second.css' }, null, 2).concat('\n'),
    'utf8'
  );

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    desiredCssFile: 'desired-second.css',
    classification: 'broken-backup',
    verificationPassed: false,
    receipt: { desiredCssFile: 'desired-first.css' },
    issues: expect.arrayContaining([
      'Tyrian manifest style does not match the desired-state record.',
    ]),
  });
});

test('apply writes a manifest receipt that identifies the owned patch surface', async () => {
  const appRoot = await createAppRoot('manifest-receipt');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: greenyellow; }\n', 'utf8');

  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });

  const manifest = JSON.parse(
    await fs.readFile(buildIslandPatchPaths(appRoot).manifestPath, 'utf8')
  ) as Record<string, unknown>;

  expect(Object.keys(manifest).toSorted()).toEqual([
    'appRoot',
    'cssChecksum',
    'desiredCssFile',
    'installedAt',
    'ownedFiles',
    'patchedProductChecksum',
    'patchedWorkbenchChecksum',
    'themeVersion',
    'upstreamProductChecksum',
    'upstreamWorkbenchChecksum',
  ]);
  expect(manifest).toMatchObject({
    desiredCssFile: 'theme.css',
    themeVersion: 'test',
    appRoot,
    ownedFiles: {
      stylesheet: ISLAND_CSS_FILE_NAME,
      manifest: ISLAND_MANIFEST_FILE_NAME,
      workbenchBackup: BACKUP_HTML_FILE_NAME,
      productBackup: BACKUP_PRODUCT_FILE_NAME,
    },
  });
  await expect(
    fs.readFile(buildManagedRootRecordPath(appRoot, registryHome), 'utf8').then(JSON.parse)
  ).resolves.toEqual({
    appRoot,
    desiredCssFile: 'theme.css',
  });
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
    registered: true,
    desiredCssFile: null,
  });
});

test('apply and restore preserve upstream workbench bytes outside the owned block', async () => {
  const appRoot = await createAppRoot('exact-upstream-workbench');
  const cssSource = path.join(testRoot, 'exact-upstream-workbench.css');
  const { backupHtmlPath, productJsonPath, workbenchHtmlPath } = buildIslandPatchPaths(appRoot);
  const upstreamHtml = `${cleanWorkbenchHtml()} \t\n\n`;
  await fs.writeFile(cssSource, '.monaco-workbench { color: blue; }\n', 'utf8');
  await fs.writeFile(workbenchHtmlPath, upstreamHtml, 'utf8');
  await fs.writeFile(productJsonPath, productJson(sha256Base64(upstreamHtml)), 'utf8');

  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  expect(await fs.readFile(backupHtmlPath, 'utf8')).toBe(upstreamHtml);

  await restoreIslandShell({ appRoot, registryHome });
  expect(await fs.readFile(workbenchHtmlPath, 'utf8')).toBe(upstreamHtml);
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
    JSON.stringify({ extensionVersion: 'old' }, null, 2).concat('\n'),
    'utf8'
  );

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'broken-backup',
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
    registered: true,
    desiredCssFile: null,
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

/** Inventory statuses for a registry that must remain fully readable. */
async function readStatuses(options: {
  preferredAppRoots?: string[];
  registryHome?: string;
}): Promise<IslandShellStatus[]> {
  const inventory = await readIslandShellInventory(options);
  expect(inventory.registryDiagnostics).toEqual([]);
  return inventory.statuses;
}

test('every crash prefix of apply keeps VS Code loadable and a rerun converges', async () => {
  const cssSource = path.join(testRoot, 'converge.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: teal; }\n', 'utf8');
  const probe = await createAppRoot('apply-prefix-probe');
  const { mutations } = await buildIslandApplyPlan({
    appRoot: probe,
    cssSourcePath: cssSource,
    themeVersion: 'test',
  });

  for (let prefix = 0; prefix <= mutations.length; prefix += 1) {
    const appRoot = await createAppRoot(`apply-prefix-${prefix}`);
    const options = { appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome };
    const plan = await buildIslandApplyPlan(options);
    await publishManagedRootRecord(appRoot, plan.desiredCssFile, { registryHome });
    await applyFileMutations(plan.mutations.slice(0, prefix), async () => {});
    await expectStylesheetReferenceResolves(appRoot);

    await applyIslandShell(options);
    const status = await readIslandShellStatus({ appRoot, registryHome });
    expect(status.classification).toBe('patched');
    expect(status.verificationPassed).toBe(true);
  }
});

test('every crash prefix of restore keeps VS Code loadable and a rerun converges', async () => {
  const cssSource = path.join(testRoot, 'restore-converge.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: plum; }\n', 'utf8');
  const probe = await createAppRoot('restore-prefix-probe');
  await applyIslandShell({
    appRoot: probe,
    cssSourcePath: cssSource,
    themeVersion: 'test',
    registryHome,
  });
  const probeState = await inspectIslandRoot(
    probe,
    await readManagedAppRootRegistration(probe, { registryHome })
  );
  const mutationCount = buildRestoreMutations(probeState, buildRestorePlan(probeState)).length;

  for (let prefix = 0; prefix <= mutationCount; prefix += 1) {
    const appRoot = await createAppRoot(`restore-prefix-${prefix}`);
    await applyIslandShell({
      appRoot,
      cssSourcePath: cssSource,
      themeVersion: 'test',
      registryHome,
    });
    await publishManagedRootRecord(appRoot, null, { registryHome });
    const state = await inspectIslandRoot(
      appRoot,
      await readManagedAppRootRegistration(appRoot, { registryHome })
    );
    const mutations = buildRestoreMutations(state, buildRestorePlan(state));
    await applyFileMutations(mutations.slice(0, prefix), async () => {});
    await expectStylesheetReferenceResolves(appRoot);

    await restoreIslandShell({ appRoot, registryHome });
    await expectRestoredAppRoot(appRoot);
  }
});

test('a mutation stops at a target changed after planning and reports external drift', async () => {
  const appRoot = await createAppRoot('planned-drift');
  const cssSource = path.join(testRoot, 'drift.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: gold; }\n', 'utf8');
  const plan = await buildIslandApplyPlan({
    appRoot,
    cssSourcePath: cssSource,
    themeVersion: 'test',
  });
  const { workbenchHtmlPath } = buildIslandPatchPaths(appRoot);
  const externalHtml = `${cleanWorkbenchHtml()}<!-- updated by VS Code -->\n`;
  await fs.writeFile(workbenchHtmlPath, externalHtml, 'utf8');

  const failure = await applyFileMutations(plan.mutations, async () => {}).catch(
    (error: unknown) => error
  );
  expect(describeIslandShellFailure(failure)).toMatchObject({
    physicalChanged: true,
    externalDrift: true,
    incompleteRecovery: true,
  });
  expect(await fs.readFile(workbenchHtmlPath, 'utf8')).toBe(externalHtml);
});

test.skipIf(process.platform !== 'linux')(
  'the CLI waits for the Island lock before mutating',
  async () => {
    const appRoot = await createAppRoot('cli-lock');
    const lockPath = buildIslandLockPath(registryHome);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const holder = Bun.spawn(['flock', lockPath, 'sh', '-c', 'echo held; sleep 1'], {
      stdout: 'pipe',
      stderr: 'inherit',
    });
    await holder.stdout.getReader().read();
    const holderReleasedAt = holder.exited.then(() => Date.now());

    const started = Date.now();
    const cli = Bun.spawn(
      [
        process.execPath,
        path.resolve('apps/vscode/src/islandCli.ts'),
        'restore-supervised',
        '--app-root',
        appRoot,
      ],
      { env: { ...process.env, HOME: registryHome }, stdout: 'pipe', stderr: 'pipe' }
    );
    const [exitCode, stdout] = await Promise.all([cli.exited, new Response(cli.stdout).text()]);
    const cliFinishedAt = Date.now();

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ restoredAppRoots: [appRoot], failedAppRoots: [] });
    expect(await holderReleasedAt).toBeLessThanOrEqual(cliFinishedAt);
    expect(cliFinishedAt - started).toBeGreaterThanOrEqual(500);
  }
);

async function expectStylesheetReferenceResolves(appRoot: string): Promise<void> {
  const paths = buildIslandPatchPaths(appRoot);
  const html = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  if (html.includes(ISLAND_CSS_FILE_NAME)) {
    await expect(fs.readFile(paths.islandCssPath, 'utf8')).resolves.toBeString();
  }
}

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
  return crypto.hash('sha256', content, 'base64').replace(/=+$/, '');
}

async function expectRestoredAppRoot(appRoot: string): Promise<void> {
  const { productJsonPath, workbenchHtmlPath } = buildIslandPatchPaths(appRoot);
  const html = await fs.readFile(workbenchHtmlPath, 'utf8');
  const product = await fs.readFile(productJsonPath, 'utf8');

  expect(html).not.toContain(TYRIAN_MARKER_START);
  expect(JSON.parse(product).checksums[WORKBENCH_CHECKSUM_KEY]).toBe(sha256Base64(html));
  await expectOnlyWorkbenchHtmlSidecarRemains(appRoot);
}

async function writeCorruptManagedRootRecord(): Promise<void> {
  const directoryPath = buildManagedRootsDirectoryPath(registryHome);
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(
    path.join(directoryPath, `${'0'.repeat(64)}.json`),
    '{ broken record\n',
    'utf8'
  );
}

async function writeManagedRootRecord(appRoot: string): Promise<string> {
  const recordPath = buildManagedRootRecordPath(appRoot, registryHome);

  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(
    recordPath,
    JSON.stringify({ appRoot, desiredCssFile: null }, null, 2).concat('\n'),
    'utf8'
  );
  return recordPath;
}

async function expectOnlyWorkbenchHtmlSidecarRemains(appRoot: string): Promise<void> {
  const paths = buildIslandPatchPaths(appRoot);

  await expect(fs.readdir(paths.workbenchDirPath)).resolves.toEqual([
    path.basename(paths.workbenchHtmlPath),
  ]);
}
