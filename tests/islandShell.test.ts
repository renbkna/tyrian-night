import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  applyIslandShell,
  readAllIslandShellStatuses,
  readAllIslandShellStatusesWithDiagnostics,
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
  TYRIAN_MARKER_END,
  TYRIAN_MARKER_START,
  WORKBENCH_CHECKSUM_KEY,
  WORKBENCH_CSS_LINK,
  buildIslandRootLockPath,
  buildIslandPatchPaths,
  buildManagedRootRecordPath,
  buildManagedRootsDirectoryPath,
} from '../apps/vscode/src/islandPatchContract';
import { publishManagedRootRecord } from '../apps/vscode/src/islandRegistry';
import { applyIslandUiSupervised } from '../apps/vscode/src/islandSupervisor';

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

  const statuses = await readAllIslandShellStatuses({
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
    const inventory = await readAllIslandShellStatusesWithDiagnostics({ registryHome });

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

test('Restore preserves a corrupt registry symlink when fixed predecessor evidence exists', async () => {
  const missingAppRoot = path.join(testRoot, 'symlinked-ambiguous-record-root');
  const recordPath = buildManagedRootRecordPath(missingAppRoot, registryHome);
  const retiredPath = durableMetadataTestPaths(recordPath).retiredPath;
  const outsideTargetPath = path.join(testRoot, 'ambiguous-record-outside-target');
  const outsideContent = 'outside ambiguous record target\n';
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(outsideTargetPath, outsideContent, 'utf8');
  await fs.symlink(outsideTargetPath, recordPath);
  await fs.writeFile(retiredPath, 'retired record evidence\n', 'utf8');

  const result = await restoreAllIslandShells({ registryHome });

  expect(result.changed).toBe(false);
  expect(result.quarantinedRecords).toEqual([]);
  expect(result.enumerationFailure).toMatchObject({
    code: 'blocked',
    reason: expect.stringContaining('durable publication evidence'),
  });
  expect((await fs.lstat(recordPath)).isSymbolicLink()).toBe(true);
  expect(await fs.readFile(outsideTargetPath, 'utf8')).toBe(outsideContent);
  expect(await fs.readFile(retiredPath, 'utf8')).toBe('retired record evidence\n');
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

test('Doctor reports legacy random registry retirement evidence without treating it as absent', async () => {
  const missingAppRoot = path.join(testRoot, 'legacy-registry-root');
  const recordPath = buildManagedRootRecordPath(missingAppRoot, registryHome);
  const legacyPath = legacyDurableRemovalPath(recordPath);
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(
    legacyPath,
    JSON.stringify({ version: 2, appRoot: missingAppRoot, desiredThemeId: 'legacy.css' }).concat(
      '\n'
    ),
    'utf8'
  );

  const inventory = await readAllIslandShellStatusesWithDiagnostics({ registryHome });

  expect(inventory.statuses).toEqual([]);
  expect(inventory.registryDiagnostics).toEqual([
    expect.stringContaining('legacy unproved deletion evidence'),
  ]);
  expect(await fs.readFile(legacyPath, 'utf8')).toContain(missingAppRoot);
});

test('supervised CLI commands exit nonzero for typed root-lock release failure', async () => {
  const appRoot = await createAppRoot('supervised-lock-release-cli');
  const cssSource = path.join(testRoot, 'supervised-lock-release.css');
  const preloadPath = path.join(testRoot, 'inject-lock-release.ts');
  const lockModulePath = path.resolve('apps/vscode/src/islandProcessLock.js');
  const lockCorePath = path.resolve('apps/vscode/src/islandProcessLockCore.ts');
  const cliPath = path.resolve('apps/vscode/src/islandCli.ts');
  await fs.writeFile(cssSource, '.monaco-workbench { color: violet; }\n', 'utf8');
  await fs.writeFile(
    preloadPath,
    [
      "import path from 'node:path';",
      "import { mock } from 'bun:test';",
      `import { IslandLockActionReleaseError, IslandLockReleaseError, isIslandLockLifecycleFailure } from ${JSON.stringify(lockCorePath)};`,
      `mock.module(${JSON.stringify(lockModulePath)}, () => ({`,
      '  IslandLockActionReleaseError,',
      '  IslandLockReleaseError,',
      '  isIslandLockLifecycleFailure,',
      '  withIslandProcessLock: async (claimPath, action) => {',
      '    const result = await action();',
      "    if (path.basename(claimPath) === '.tyrian-night.lock') {",
      "      throw new IslandLockReleaseError(claimPath, result, new Error('injected persistent release failure'));",
      '    }',
      '    return result;',
      '  },',
      '}));',
      '',
    ].join('\n'),
    'utf8'
  );

  const commands = [
    [
      'apply-supervised',
      '--app-root',
      appRoot,
      '--css-source',
      cssSource,
      '--theme-version',
      'test',
    ],
    ['restore-supervised', '--app-root', appRoot],
  ];

  for (const command of commands) {
    const child = Bun.spawn([process.execPath, '--preload', preloadPath, cliPath, ...command], {
      env: { ...process.env, HOME: registryHome },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const failure = JSON.parse(stderr.trim());

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(failure).toMatchObject({
      version: 2,
      code: 'blocked',
      physicalChanged: true,
      incompleteRecovery: true,
      causes: expect.arrayContaining([
        expect.objectContaining({ reason: expect.stringContaining('.tyrian-night.lock') }),
        expect.objectContaining({ reason: 'injected persistent release failure' }),
      ]),
    });
  }
});

test('status-all reports registered missing roots without mutating the registry', async () => {
  const missingAppRoot = path.join(testRoot, 'missing-root');
  const recordPath = await writeManagedRootRecord(missingAppRoot);
  const before = await fs.readFile(recordPath, 'utf8');

  const statuses = await readAllIslandShellStatuses({ registryHome });

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

test('unsupported desired records are report-only and untouched by direct or bulk restore', async () => {
  const appRoot = await createAppRoot('unsupported-record');
  const cssSource = path.join(testRoot, 'unsupported-record.css');
  const recordPath = buildManagedRootRecordPath(appRoot, registryHome);
  const paths = buildIslandPatchPaths(appRoot);
  await fs.writeFile(cssSource, '.monaco-workbench { color: cyan; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });

  const unsupportedRecord = JSON.stringify({ version: 1, appRoot }).concat('\n');
  const workbenchBefore = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, unsupportedRecord, 'utf8');

  await expect(readAllIslandShellStatusesWithDiagnostics({ registryHome })).resolves.toMatchObject({
    statuses: [],
    registryDiagnostics: [expect.stringContaining('expected version 2 with an absolute appRoot')],
  });
  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    registrationState: 'unsupported',
    registered: false,
  });

  await expect(restoreIslandShell({ appRoot, registryHome })).rejects.toThrow(
    'expected version 2 with an absolute appRoot'
  );
  expect(await fs.readFile(recordPath, 'utf8')).toBe(unsupportedRecord);
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(workbenchBefore);

  await expect(restoreAllIslandShells({ registryHome })).resolves.toMatchObject({
    changed: false,
    failedAppRoots: [],
    enumerationFailure: { code: 'corrupt' },
  });
  expect(await fs.readFile(recordPath, 'utf8')).toBe(unsupportedRecord);
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(workbenchBefore);
});

test('unsupported desired records block current transaction recovery before mutation', async () => {
  const appRoot = await createAppRoot('unsupported-record-with-recovery');
  const paths = buildIslandPatchPaths(appRoot);
  const recordPath = buildManagedRootRecordPath(appRoot, registryHome);
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const desiredHtml = originalHtml.replace('</head>', '<meta name="interrupted">\n\t</head>');
  const originalStats = await fs.lstat(paths.workbenchHtmlPath);
  const transactionId = crypto.randomUUID();
  const backupPath = transactionTemporaryPath(paths.workbenchHtmlPath, transactionId, 'backup');
  const stagedPath = transactionTemporaryPath(paths.workbenchHtmlPath, transactionId, 'stage');
  const retiredPath = transactionTemporaryPath(paths.workbenchHtmlPath, transactionId, 'retired');
  const unsupportedRecord = JSON.stringify({ version: 1, appRoot }).concat('\n');

  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, unsupportedRecord, 'utf8');
  await fs.copyFile(paths.workbenchHtmlPath, backupPath);
  await fs.writeFile(stagedPath, desiredHtml, 'utf8');
  await fs.chmod(stagedPath, originalStats.mode);
  await fs.rename(paths.workbenchHtmlPath, retiredPath);
  await fs.link(stagedPath, paths.workbenchHtmlPath);
  const journal = JSON.stringify(
    {
      version: 4,
      id: transactionId,
      appRoot,
      phase: 'committing',
      entries: [
        {
          filePath: paths.workbenchHtmlPath,
          backupPath,
          stagedPath,
          retiredPath,
          existed: true,
          originalChecksum: sha256Base64(originalHtml),
          desiredChecksum: sha256Base64(desiredHtml),
          originalMode: Number(originalStats.mode),
          originalDevice: String(originalStats.dev),
          originalInode: String(originalStats.ino),
        },
      ],
    },
    null,
    2
  ).concat('\n');
  await fs.writeFile(paths.transactionJournalPath, journal, 'utf8');

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    registrationState: 'unsupported',
    transaction: { kind: 'recoverable', version: 4 },
  });
  await expect(restoreIslandShell({ appRoot, registryHome })).rejects.toThrow(
    'expected version 2 with an absolute appRoot'
  );

  expect(await fs.readFile(recordPath, 'utf8')).toBe(unsupportedRecord);
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(desiredHtml);
  expect(await fs.readFile(backupPath, 'utf8')).toBe(originalHtml);
  expect(await fs.readFile(stagedPath, 'utf8')).toBe(desiredHtml);
  expect(await fs.readFile(retiredPath, 'utf8')).toBe(originalHtml);
  expect(await fs.readFile(paths.transactionJournalPath, 'utf8')).toBe(journal);
});

test('unidentifiable unsupported desired records remain untouched by bulk restore', async () => {
  const appRoot = await createAppRoot('unidentifiable-unsupported-record');
  const recordPath = buildManagedRootRecordPath(appRoot, registryHome);
  const unsupportedRecord = JSON.stringify({ version: 1 }).concat('\n');
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, unsupportedRecord, 'utf8');

  await expect(restoreAllIslandShells({ registryHome })).resolves.toMatchObject({
    changed: false,
    failedAppRoots: [],
    enumerationFailure: { code: 'corrupt' },
  });
  expect(await fs.readFile(recordPath, 'utf8')).toBe(unsupportedRecord);
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

  expect(
    (await readAllIslandShellStatuses({ registryHome })).map(({ appRoot }) => appRoot)
  ).toEqual([...appRoots].sort((left, right) => left.localeCompare(right)));

  await Promise.all(appRoots.map((appRoot) => restoreIslandShell({ appRoot, registryHome })));

  expect(await readAllIslandShellStatuses({ registryHome })).toHaveLength(appRoots.length);
  expect(await readAllIslandShellStatuses({ registryHome })).toEqual(
    expect.arrayContaining(
      appRoots.map((appRoot) =>
        expect.objectContaining({ appRoot, registrationState: 'valid', desiredThemeId: null })
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
  await readAllIslandShellStatuses({ registryHome });

  const publications = appRoots.map((appRoot) =>
    applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome })
  );
  const snapshots = await Promise.all(
    Array.from({ length: 12 }, () => readAllIslandShellStatuses({ registryHome }))
  );
  await Promise.all(publications);

  for (const statuses of snapshots) {
    expect(new Set(statuses.map(({ appRoot }) => appRoot)).size).toBe(statuses.length);
    expect(statuses.every(({ registrationState }) => registrationState === 'valid')).toBe(true);
  }
});

test('registry publication preserves a same-content replacement inode at retirement', async () => {
  const appRoot = await createAppRoot('registry-publication-replacement');
  const firstCss = path.join(testRoot, 'registry-publication-first.css');
  const secondCss = path.join(testRoot, 'registry-publication-second.css');
  await fs.writeFile(firstCss, '.monaco-workbench { color: red; }\n', 'utf8');
  await fs.writeFile(secondCss, '.monaco-workbench { color: blue; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: firstCss, themeVersion: 'first', registryHome });
  const recordPath = buildManagedRootRecordPath(appRoot, registryHome);
  const recordContent = await fs.readFile(recordPath, 'utf8');
  const originalStats = await fs.lstat(recordPath);
  const originalRename = fs.rename;
  let injected = false;

  fs.rename = (async (sourcePath, targetPath) => {
    if (
      !injected &&
      String(sourcePath) === recordPath &&
      path.basename(String(targetPath)) === `.tyrian-night-retired-${path.basename(recordPath)}.tmp`
    ) {
      injected = true;
      const replacementPath = path.join(path.dirname(recordPath), 'replacement-record.tmp');
      await fs.writeFile(replacementPath, recordContent, 'utf8');
      await originalRename(replacementPath, recordPath);
    }
    return originalRename(sourcePath, targetPath);
  }) as typeof fs.rename;

  try {
    await expect(
      applyIslandShell({
        appRoot,
        cssSourcePath: secondCss,
        themeVersion: 'second',
        registryHome,
      })
    ).rejects.toMatchObject({
      changed: false,
      desiredStateChanged: false,
      registryChanged: false,
      physicalChanged: false,
      externalDrift: true,
    });
  } finally {
    fs.rename = originalRename;
  }

  const replacementStats = await fs.lstat(recordPath);
  expect(injected).toBe(true);
  expect(await fs.readFile(recordPath, 'utf8')).toBe(recordContent);
  expect(`${replacementStats.dev}:${replacementStats.ino}`).not.toBe(
    `${originalStats.dev}:${originalStats.ino}`
  );
});

test('same-root mutations serialize into one complete patch receipt', async () => {
  const appRoot = await createAppRoot('same-root-concurrency');
  const cssSources = await Promise.all(
    ['red', 'blue'].map(async (color) => {
      const cssPath = path.join(testRoot, `${color}.css`);
      await fs.writeFile(cssPath, `.monaco-workbench { color: ${color}; }\n`, 'utf8');
      return cssPath;
    })
  );

  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      applyIslandShell({
        appRoot,
        cssSourcePath: cssSources[index % cssSources.length]!,
        themeVersion: `test-${index}`,
        registryHome,
      })
    )
  );

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'patched',
    verificationPassed: true,
  });
  const installedCss = await fs.readFile(buildIslandPatchPaths(appRoot).islandCssPath, 'utf8');
  expect(await Promise.all(cssSources.map((cssPath) => fs.readFile(cssPath, 'utf8')))).toContain(
    installedCss
  );
});

test('physical app-root aliases share one lock, record, and manifest authority', async () => {
  const appRoot = await createAppRoot('physical-root');
  const aliasRoot = path.join(testRoot, 'root-alias');
  const firstCss = path.join(testRoot, 'alias-first.css');
  const secondCss = path.join(testRoot, 'alias-second.css');
  await fs.symlink(appRoot, aliasRoot, 'dir');
  await fs.writeFile(firstCss, '.monaco-workbench { color: red; }\n', 'utf8');
  await fs.writeFile(secondCss, '.monaco-workbench { color: blue; }\n', 'utf8');

  await Promise.all([
    applyIslandShell({ appRoot, cssSourcePath: firstCss, themeVersion: 'first', registryHome }),
    applyIslandShell({
      appRoot: aliasRoot,
      cssSourcePath: secondCss,
      themeVersion: 'second',
      registryHome,
    }),
  ]);

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

test('patch admission rejects a symlinked workbench ancestor before any mutation', async () => {
  const appRoot = await createAppRoot('symlinked-workbench-ancestor');
  const paths = buildIslandPatchPaths(appRoot);
  const externalWorkbench = path.join(testRoot, 'external-workbench');
  const cssSource = path.join(testRoot, 'symlinked-workbench.css');
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  await fs.rm(paths.workbenchDirPath, { recursive: true });
  await fs.mkdir(externalWorkbench);
  await fs.writeFile(
    path.join(externalWorkbench, path.basename(paths.workbenchHtmlPath)),
    originalHtml
  );
  await fs.symlink(externalWorkbench, paths.workbenchDirPath, 'dir');
  await fs.writeFile(cssSource, '.monaco-workbench { color: red; }\n', 'utf8');

  await expect(
    applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome })
  ).rejects.toThrow('patch ancestor');
  expect(await fs.readFile(path.join(externalWorkbench, 'workbench.html'), 'utf8')).toBe(
    originalHtml
  );
  expect(await fs.readdir(externalWorkbench)).toEqual(['workbench.html']);
  await expect(fs.stat(buildManagedRootRecordPath(appRoot, registryHome))).rejects.toThrow();
});

test('apply rejects an mv without atomic exchange support before any Island mutation', async () => {
  const appRoot = await createAppRoot('unsupported-atomic-exchange');
  const paths = buildIslandPatchPaths(appRoot);
  const cssSource = path.join(testRoot, 'unsupported-atomic-exchange.css');
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  await fs.writeFile(cssSource, '.monaco-workbench { color: red; }\n', 'utf8');

  const child = await runIslandApplyCli(
    appRoot,
    cssSource,
    await writeIslandTestMv('unsupported-exchange')
  );
  expect(child.exitCode).not.toBe(0);
  expect(JSON.parse(child.stderr.trim())).toMatchObject({
    code: 'unsupported',
    reason: expect.stringContaining('requires GNU mv with --exchange'),
  });
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(originalHtml);
  await expect(fs.lstat(paths.transactionJournalPath)).rejects.toThrow();
  await expect(fs.lstat(buildManagedRootRecordPath(appRoot, registryHome))).rejects.toThrow();
});

test('atomic publication preserves an exchanged external generation as journal evidence', async () => {
  const appRoot = await createAppRoot('replacement-at-exchange');
  const cssSource = path.join(testRoot, 'replacement-at-exchange.css');
  const paths = buildIslandPatchPaths(appRoot);
  const replacement = 'external replacement generation\n';
  await fs.writeFile(cssSource, '.monaco-workbench { color: red; }\n', 'utf8');
  const fakeMvDirectory = await writeIslandTestMv('external-replacement');

  const child = await runIslandApplyCli(appRoot, cssSource, fakeMvDirectory, {
    targetPath: paths.workbenchHtmlPath,
    replacement,
  });
  expect(child.exitCode).not.toBe(0);
  expect(JSON.parse(child.stderr.trim())).toMatchObject({
    code: 'blocked',
    externalDrift: true,
    incompleteRecovery: true,
  });

  const journal = JSON.parse(await fs.readFile(paths.transactionJournalPath, 'utf8')) as {
    version: number;
    recovery?: { id: string; phase: string };
    entries: Array<{ filePath: string; publicationPath?: string }>;
  };
  const workbenchEntry = journal.entries.find(
    ({ filePath }) => filePath === paths.workbenchHtmlPath
  );
  expect(journal.version).toBe(5);
  expect(journal.recovery).toMatchObject({ phase: 'fencing' });
  expect(workbenchEntry?.publicationPath).toBeDefined();
  const recoveryEvidencePath = path.join(
    path.dirname(workbenchEntry!.publicationPath!),
    `.tyrian-night-${journal.recovery!.id}-recovery-${path.basename(workbenchEntry!.filePath)}.tmp`
  );
  expect(await fs.readFile(recoveryEvidencePath, 'utf8')).toBe(replacement);
  const externalIdentity = JSON.parse(
    await fs.readFile(`${paths.workbenchHtmlPath}.external-identity.json`, 'utf8')
  );
  const preserved = await fs.lstat(recoveryEvidencePath);
  expect({ device: String(preserved.dev), inode: String(preserved.ino) }).toEqual(externalIdentity);
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toContain(TYRIAN_MARKER_START);
});

test('descriptor-anchored atomic exchange cannot be redirected by an admitted ancestor swap', async () => {
  const appRoot = await createAppRoot('ancestor-swap-at-retirement');
  const cssSource = path.join(testRoot, 'ancestor-swap-at-retirement.css');
  const paths = buildIslandPatchPaths(appRoot);
  const displacedWorkbench = path.join(testRoot, 'displaced-workbench');
  const externalWorkbench = await fs.mkdtemp(
    path.join(os.tmpdir(), 'tyrian-island-ancestor-external-')
  );
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  await fs.writeFile(path.join(externalWorkbench, 'workbench.html'), originalHtml, 'utf8');
  await fs.writeFile(cssSource, '.monaco-workbench { color: red; }\n', 'utf8');

  try {
    const fakeMvDirectory = await writeIslandTestMv('ancestor-swap');
    const child = await runIslandApplyCli(appRoot, cssSource, fakeMvDirectory, {
      workbenchDirectory: paths.workbenchDirPath,
      displacedWorkbench,
      externalWorkbench,
    });
    expect(child.exitCode).not.toBe(0);
    expect(JSON.parse(child.stderr.trim())).toMatchObject({
      code: 'blocked',
      reason: expect.stringContaining('patch namespace changed'),
    });
    expect(await fs.readdir(externalWorkbench)).toEqual(['workbench.html']);
    expect(await fs.readFile(path.join(externalWorkbench, 'workbench.html'), 'utf8')).toBe(
      originalHtml
    );
    expect((await fs.lstat(path.join(displacedWorkbench, 'workbench.html'))).isFile()).toBe(true);
  } finally {
    await fs.rm(externalWorkbench, { recursive: true, force: true });
  }
});

test('different registry homes serialize mutation through one physical app-root claim', async () => {
  const appRoot = await createAppRoot('cross-registry-root');
  const firstHome = path.join(testRoot, 'first-home');
  const secondHome = path.join(testRoot, 'second-home');
  const firstCss = path.join(testRoot, 'cross-home-first.css');
  const secondCss = path.join(testRoot, 'cross-home-second.css');
  const rootLockPath = buildIslandRootLockPath(appRoot);
  await fs.writeFile(firstCss, '.monaco-workbench { color: red; }\n', 'utf8');
  await fs.writeFile(secondCss, '.monaco-workbench { color: blue; }\n', 'utf8');
  await fs.writeFile(
    rootLockPath,
    JSON.stringify({
      version: 3,
      pid: process.pid,
      token: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      processIdentity: await currentLockProcessIdentity(),
    }).concat('\n'),
    'utf8'
  );
  let settled = 0;

  const mutations = [
    applyIslandShell({
      appRoot,
      cssSourcePath: firstCss,
      themeVersion: 'first',
      registryHome: firstHome,
    }),
    applyIslandShell({
      appRoot,
      cssSourcePath: secondCss,
      themeVersion: 'second',
      registryHome: secondHome,
    }),
  ].map((mutation) =>
    mutation.finally(() => {
      settled += 1;
    })
  );

  await delay(80);
  expect(settled).toBe(0);
  await fs.unlink(rootLockPath);
  await Promise.all(mutations);

  const paths = buildIslandPatchPaths(appRoot);
  const manifest = JSON.parse(await fs.readFile(paths.manifestPath, 'utf8'));
  const installedCss = await fs.readFile(paths.islandCssPath, 'utf8');
  expect(manifest.cssChecksum).toBe(sha256Base64(installedCss));
  expect([path.basename(firstCss), path.basename(secondCss)]).toContain(manifest.desiredThemeId);
  expect((await fs.stat(buildManagedRootRecordPath(appRoot, firstHome))).isFile()).toBe(true);
  expect((await fs.stat(buildManagedRootRecordPath(appRoot, secondHome))).isFile()).toBe(true);
});

test('a fresh owner-file acquisition gap is not stolen', async () => {
  const appRoot = await createAppRoot('lock-acquisition-gap');
  const cssSource = path.join(testRoot, 'lock-gap.css');
  const lockPath = buildIslandRootLockPath(appRoot);
  await fs.writeFile(cssSource, '.monaco-workbench { color: cyan; }\n', 'utf8');
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, '', 'utf8');

  let settled = false;
  const apply = applyIslandShell({
    appRoot,
    cssSourcePath: cssSource,
    themeVersion: 'test',
    registryHome,
  }).finally(() => {
    settled = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(settled).toBe(false);
  await fs.rm(lockPath, { force: true });
  await expect(apply).resolves.toMatchObject({ active: true });
});

test('a live lock owner is never stolen because of age', async () => {
  const appRoot = await createAppRoot('live-old-lock');
  const cssSource = path.join(testRoot, 'live-old-lock.css');
  const lockPath = buildIslandRootLockPath(appRoot);
  await fs.writeFile(cssSource, '.monaco-workbench { color: cyan; }\n', 'utf8');
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      version: 3,
      token: crypto.randomUUID(),
      pid: process.pid,
      createdAt: '2000-01-01T00:00:00.000Z',
      processIdentity: await currentLockProcessIdentity(),
    }),
    'utf8'
  );

  let settled = false;
  const apply = applyIslandShell({
    appRoot,
    cssSourcePath: cssSource,
    themeVersion: 'test',
    registryHome,
  }).finally(() => {
    settled = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(settled).toBe(false);
  await fs.rm(lockPath, { force: true });
  await expect(apply).resolves.toMatchObject({ active: true });
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
    desiredThemeId: null,
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
  await expect(readAllIslandShellStatuses({ registryHome })).resolves.toMatchObject([
    { appRoot, registrationState: 'valid', desiredThemeId: null, classification: 'clean' },
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
  await expect(readAllIslandShellStatuses({ registryHome })).resolves.toMatchObject([
    { appRoot, registrationState: 'valid', desiredThemeId: null, classification: 'clean' },
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
  ).rejects.toThrow('requires a CSS asset desiredThemeId');
  await expect(fs.stat(buildManagedRootsDirectoryPath(registryHome))).rejects.toThrow();
});

test('quarantine sync failure preserves the post-rename changed fact and path', async () => {
  const recordDirectory = buildManagedRootsDirectoryPath(registryHome);
  const recordPath = buildManagedRootRecordPath(
    path.join(testRoot, 'quarantine-sync-root'),
    registryHome
  );
  await fs.mkdir(recordDirectory, { recursive: true });
  await fs.writeFile(recordPath, '{ broken\n', 'utf8');
  const originalOpen = fs.open;
  let injected = false;
  fs.open = (async (filePath, ...args: unknown[]) => {
    const handle = await (originalOpen as any)(filePath, ...args);
    if (path.basename(String(filePath)) === 'quarantined-managed-app-roots') {
      handle.sync = async () => {
        injected = true;
        throw new Error('injected directory sync failure');
      };
    }
    return handle;
  }) as typeof fs.open;

  let result: Awaited<ReturnType<typeof restoreAllIslandShells>>;
  try {
    result = await restoreAllIslandShells({ registryHome });
  } finally {
    fs.open = originalOpen;
  }
  expect(injected).toBe(true);
  expect(result).toMatchObject({ changed: true, registryChanged: true, incompleteRecovery: true });
  expect(result.quarantinedRecords).toHaveLength(1);
  expect(result.enumerationFailure?.reason).toContain('injected directory sync failure');
  await expect(fs.stat(recordPath)).rejects.toThrow();
  expect(await fs.readFile(result.quarantinedRecords[0]!, 'utf8')).toBe('{ broken\n');
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
  await expect(readAllIslandShellStatuses({ registryHome })).resolves.toEqual([]);
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

test('missing-root cleanup does not pair parsed registry content with a newer generation', async () => {
  const missingAppRoot = path.join(testRoot, 'missing-root-generation');
  const recordPath = await writeManagedRootRecord(missingAppRoot);
  const replacementContent = JSON.stringify(
    { version: 2, appRoot: missingAppRoot, desiredThemeId: 'replacement.css' },
    null,
    2
  ).concat('\n');
  const originalReadFile = fs.readFile;
  let injected = false;

  fs.readFile = (async (filePath, ...argumentsList: unknown[]) => {
    const content = await (originalReadFile as any)(filePath, ...argumentsList);
    if (!injected && String(filePath) === recordPath) {
      injected = true;
      await fs.writeFile(recordPath, replacementContent, 'utf8');
    }
    return content;
  }) as typeof fs.readFile;

  let result: Awaited<ReturnType<typeof restoreAllIslandShells>>;
  try {
    result = await restoreAllIslandShells({ registryHome });
  } finally {
    fs.readFile = originalReadFile;
  }

  expect(injected).toBe(true);
  expect(result.failedAppRoots).toEqual([
    expect.objectContaining({
      appRoot: missingAppRoot,
      reason: expect.stringContaining('changed during restore'),
    }),
  ]);
  expect(await fs.readFile(recordPath, 'utf8')).toBe(replacementContent);
});

test('missing-root cleanup preserves a replacement registry generation at retirement', async () => {
  const missingAppRoot = path.join(testRoot, 'missing-root-replacement');
  const recordPath = await writeManagedRootRecord(missingAppRoot);
  const content = await fs.readFile(recordPath, 'utf8');
  const originalStats = await fs.lstat(recordPath);
  const originalRename = fs.rename;
  let injected = false;

  fs.rename = (async (sourcePath, targetPath) => {
    if (
      !injected &&
      String(sourcePath) === recordPath &&
      path.basename(String(targetPath)).includes('-retired-')
    ) {
      injected = true;
      const replacementPath = path.join(path.dirname(recordPath), 'missing-root-replacement.tmp');
      await fs.writeFile(replacementPath, content, 'utf8');
      await originalRename(replacementPath, recordPath);
    }
    return originalRename(sourcePath, targetPath);
  }) as typeof fs.rename;

  let result: Awaited<ReturnType<typeof restoreAllIslandShells>>;
  try {
    result = await restoreAllIslandShells({ registryHome });
  } finally {
    fs.rename = originalRename;
  }

  const replacementStats = await fs.lstat(recordPath);
  expect(injected).toBe(true);
  expect(result.failedAppRoots).toEqual([
    expect.objectContaining({
      appRoot: missingAppRoot,
      code: 'blocked',
      reason: expect.stringContaining('changed across retirement'),
    }),
  ]);
  expect(await fs.readFile(recordPath, 'utf8')).toBe(content);
  expect(`${replacementStats.dev}:${replacementStats.ino}`).not.toBe(
    `${originalStats.dev}:${originalStats.ino}`
  );
});

test('Restore quarantines an identifiable corrupt record for a missing root by generation', async () => {
  const missingAppRoot = path.join(testRoot, 'missing-corrupt-root');
  const recordPath = buildManagedRootRecordPath(missingAppRoot, registryHome);
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(
    recordPath,
    JSON.stringify({ version: 2, appRoot: missingAppRoot, desiredThemeId: 42 }).concat('\n'),
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

test('registry quarantine preserves a same-content replacement inode at retirement', async () => {
  const missingAppRoot = path.join(testRoot, 'missing-quarantine-replacement');
  const recordPath = buildManagedRootRecordPath(missingAppRoot, registryHome);
  const content = JSON.stringify({
    version: 2,
    appRoot: missingAppRoot,
    desiredThemeId: 42,
  }).concat('\n');
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, content, 'utf8');
  const originalStats = await fs.lstat(recordPath);
  const originalRename = fs.rename;
  let injected = false;

  fs.rename = (async (sourcePath, targetPath) => {
    if (
      !injected &&
      String(sourcePath) === recordPath &&
      path.dirname(String(targetPath)).includes('quarantined-managed-app-roots')
    ) {
      injected = true;
      const replacementPath = path.join(path.dirname(recordPath), 'quarantine-replacement.tmp');
      await fs.writeFile(replacementPath, content, 'utf8');
      await originalRename(replacementPath, recordPath);
    }
    return originalRename(sourcePath, targetPath);
  }) as typeof fs.rename;

  let result: Awaited<ReturnType<typeof restoreAllIslandShells>>;
  try {
    result = await restoreAllIslandShells({ registryHome });
  } finally {
    fs.rename = originalRename;
  }

  const replacementStats = await fs.lstat(recordPath);
  expect(injected).toBe(true);
  expect(result.failedAppRoots).toEqual([
    expect.objectContaining({
      appRoot: missingAppRoot,
      code: 'blocked',
      reason: expect.stringContaining('changed across quarantine'),
    }),
  ]);
  expect(await fs.readFile(recordPath, 'utf8')).toBe(content);
  expect(`${replacementStats.dev}:${replacementStats.ino}`).not.toBe(
    `${originalStats.dev}:${originalStats.ino}`
  );
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
    desiredThemeId: null,
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
    desiredThemeId: undefined,
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
    JSON.stringify({ version: 2, appRoot, desiredThemeId: 42 }, null, 2).concat('\n'),
    'utf8'
  );

  await expect(readAllIslandShellStatuses({ registryHome })).resolves.toMatchObject([
    { appRoot, registrationState: 'corrupt', classification: 'broken-backup' },
  ]);

  await expect(restoreIslandShell({ appRoot, registryHome })).resolves.toMatchObject({
    changed: true,
    active: false,
  });
  await expect(fs.readFile(recordPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
    version: 2,
    appRoot,
    desiredThemeId: null,
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
    desiredThemeId: null,
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
    desiredThemeId: null,
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
    JSON.stringify({ version: 2, appRoot, desiredThemeId: 'desired-second.css' }, null, 2).concat(
      '\n'
    ),
    'utf8'
  );

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    desiredThemeId: 'desired-second.css',
    classification: 'broken-backup',
    verificationPassed: false,
    receipt: { desiredThemeId: 'desired-first.css' },
    issues: expect.arrayContaining([
      'Tyrian manifest style does not match the desired-state record.',
    ]),
  });
});

test('apply writes a v3 manifest receipt that identifies the owned patch surface', async () => {
  const appRoot = await createAppRoot('manifest-v3');
  const cssSource = path.join(testRoot, 'theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: greenyellow; }\n', 'utf8');

  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });

  const manifest = JSON.parse(
    await fs.readFile(buildIslandPatchPaths(appRoot).manifestPath, 'utf8')
  ) as Record<string, unknown>;

  expect(manifest).toMatchObject({
    version: 3,
    desiredThemeId: 'theme.css',
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
  await expect(
    fs.readFile(buildManagedRootRecordPath(appRoot, registryHome), 'utf8').then(JSON.parse)
  ).resolves.toMatchObject({
    version: 2,
    appRoot,
    desiredThemeId: 'theme.css',
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
    desiredThemeId: null,
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
    JSON.stringify({ version: 1, extensionVersion: 'old' }, null, 2).concat('\n'),
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
    desiredThemeId: null,
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
  await writeCorruptManagedRootRecord();

  await expect(
    applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome })
  ).rejects.toThrow('Tyrian managed app root record is invalid JSON');
  await expectRestoredAppRoot(appRoot);
});

test('noncurrent transaction journal versions are corrupt and left untouched', async () => {
  const appRoot = await createAppRoot('external-drift-recovery');
  const paths = buildIslandPatchPaths(appRoot);
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const originalStats = await fs.lstat(paths.workbenchHtmlPath);
  const id = crypto.randomUUID();
  const journal = JSON.stringify({
    version: 3,
    id,
    appRoot,
    phase: 'prepared',
    entries: [
      {
        filePath: paths.workbenchHtmlPath,
        backupPath: transactionTemporaryPath(paths.workbenchHtmlPath, id, 'backup'),
        stagedPath: transactionTemporaryPath(paths.workbenchHtmlPath, id, 'stage'),
        existed: true,
        originalChecksum: sha256Base64(originalHtml),
        desiredChecksum: sha256Base64(`${originalHtml}\n`),
        originalMode: Number(originalStats.mode),
        originalDevice: String(originalStats.dev),
        originalInode: String(originalStats.ino),
        retiredPath: transactionTemporaryPath(paths.workbenchHtmlPath, id, 'retired'),
      },
    ],
  }).concat('\n');
  await fs.writeFile(paths.transactionJournalPath, journal, 'utf8');

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'transaction-blocked',
    transaction: {
      kind: 'corrupt',
      recoverability: 'manual',
      reason: expect.stringContaining('invalid'),
    },
  });
  await expect(restoreIslandShell({ appRoot, registryHome })).rejects.toThrow(
    'Tyrian file transaction journal is invalid'
  );
  expect(await fs.readFile(paths.transactionJournalPath, 'utf8')).toBe(journal);
});

test('v4 transaction recovery restores the retired generation and removes its evidence', async () => {
  const appRoot = await createAppRoot('v4-retired-recovery');
  const paths = buildIslandPatchPaths(appRoot);
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const desiredHtml = originalHtml.replace('</head>', '<meta name="desired">\n\t</head>');
  const id = crypto.randomUUID();
  const backupPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'backup');
  const stagedPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'stage');
  const retiredPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'retired');
  const originalStats = await fs.lstat(paths.workbenchHtmlPath);
  await fs.copyFile(paths.workbenchHtmlPath, backupPath);
  await fs.writeFile(stagedPath, desiredHtml, 'utf8');
  await fs.chmod(stagedPath, originalStats.mode);
  await fs.rename(paths.workbenchHtmlPath, retiredPath);
  await fs.link(stagedPath, paths.workbenchHtmlPath);
  await fs.writeFile(
    paths.transactionJournalPath,
    JSON.stringify(
      {
        version: 4,
        id,
        appRoot,
        phase: 'committing',
        entries: [
          {
            filePath: paths.workbenchHtmlPath,
            backupPath,
            stagedPath,
            retiredPath,
            existed: true,
            originalChecksum: sha256Base64(originalHtml),
            desiredChecksum: sha256Base64(desiredHtml),
            originalMode: Number(originalStats.mode),
            originalDevice: String(originalStats.dev),
            originalInode: String(originalStats.ino),
          },
        ],
      },
      null,
      2
    ).concat('\n'),
    'utf8'
  );

  await expect(restoreIslandShell({ appRoot, registryHome })).resolves.toMatchObject({
    physicalChanged: true,
  });
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(originalHtml);
  expect(Number((await fs.lstat(paths.workbenchHtmlPath)).mode)).toBe(Number(originalStats.mode));
  for (const evidencePath of [backupPath, stagedPath, retiredPath, paths.transactionJournalPath]) {
    await expect(fs.lstat(evidencePath)).rejects.toThrow();
  }
});

test('Doctor and supervised apply recover a v4 target retired before staged publication', async () => {
  const appRoot = await createAppRoot('v4-retire-publication-gap');
  const paths = buildIslandPatchPaths(appRoot);
  const cssSource = path.join(testRoot, 'v4-retire-publication-gap.css');
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const originalStats = await fs.lstat(paths.workbenchHtmlPath);
  const desiredHtml = `${originalHtml}\n<!-- interrupted desired generation -->\n`;
  const id = crypto.randomUUID();
  const backupPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'backup');
  const stagedPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'stage');
  const retiredPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'retired');
  await fs.writeFile(cssSource, '.monaco-workbench { color: violet; }\n', 'utf8');
  await fs.writeFile(backupPath, originalHtml, 'utf8');
  await fs.writeFile(stagedPath, desiredHtml, 'utf8');
  await fs.rename(paths.workbenchHtmlPath, retiredPath);
  await fs.writeFile(
    paths.transactionJournalPath,
    JSON.stringify(
      {
        version: 4,
        id,
        appRoot,
        phase: 'committing',
        entries: [
          {
            filePath: paths.workbenchHtmlPath,
            backupPath,
            stagedPath,
            retiredPath,
            existed: true,
            originalChecksum: sha256Base64(originalHtml),
            desiredChecksum: sha256Base64(desiredHtml),
            originalMode: Number(originalStats.mode),
            originalDevice: String(originalStats.dev),
            originalInode: String(originalStats.ino),
          },
        ],
      },
      null,
      2
    ).concat('\n'),
    'utf8'
  );

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'transaction-pending',
    transaction: {
      kind: 'recoverable',
      version: 4,
      recoverability: 'automatic',
    },
  });
  await expect(
    applyIslandUiSupervised({
      appRoot,
      cssSourcePath: cssSource,
      themeVersion: 'test',
      registryHome,
    })
  ).resolves.toMatchObject({
    kind: 'applied',
    physicalChanged: true,
  });
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toContain(TYRIAN_MARKER_START);
  for (const ownedPath of [backupPath, stagedPath, retiredPath, paths.transactionJournalPath]) {
    await expect(fs.lstat(ownedPath)).rejects.toThrow();
  }
});

test('prepared v5 recovery validates its publication before removing the staged proof', async () => {
  const appRoot = await createAppRoot('v5-prepared-publication');
  const paths = buildIslandPatchPaths(appRoot);
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const originalStats = await fs.lstat(paths.workbenchHtmlPath);
  const desiredHtml = `${originalHtml}\n<!-- prepared desired generation -->\n`;
  const id = crypto.randomUUID();
  const backupPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'backup');
  const stagedPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'stage');
  const publicationPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'publication');
  await fs.copyFile(paths.workbenchHtmlPath, backupPath);
  await fs.writeFile(stagedPath, desiredHtml, 'utf8');
  await fs.chmod(stagedPath, originalStats.mode);
  await fs.link(stagedPath, publicationPath);
  await fs.writeFile(
    paths.transactionJournalPath,
    JSON.stringify(
      {
        version: 5,
        id,
        appRoot,
        phase: 'prepared',
        entries: [
          {
            filePath: paths.workbenchHtmlPath,
            backupPath,
            stagedPath,
            publicationPath,
            existed: true,
            originalChecksum: sha256Base64(originalHtml),
            desiredChecksum: sha256Base64(desiredHtml),
            originalMode: Number(originalStats.mode),
            originalDevice: String(originalStats.dev),
            originalInode: String(originalStats.ino),
          },
        ],
      },
      null,
      2
    ).concat('\n'),
    'utf8'
  );

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'transaction-pending',
    transaction: {
      kind: 'recoverable',
      recoverability: 'automatic',
      version: 5,
      phase: 'prepared',
    },
  });
  await expect(restoreIslandShell({ appRoot, registryHome })).resolves.toMatchObject({
    physicalChanged: false,
  });
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(originalHtml);
  for (const evidencePath of [
    backupPath,
    stagedPath,
    publicationPath,
    paths.transactionJournalPath,
  ]) {
    await expect(fs.lstat(evidencePath)).rejects.toThrow();
  }
});

test('a SIGKILL during preparing-stage population leaves disposable scratch for Doctor and supervised apply', async () => {
  const appRoot = await createAppRoot('preparing-stage-kill');
  const paths = buildIslandPatchPaths(appRoot);
  const cssSource = path.join(testRoot, 'preparing-stage-kill.css');
  const preloadPath = await writeIslandPreparingStageKillPreload();
  await fs.writeFile(cssSource, '.monaco-workbench { color: teal; }\n', 'utf8');

  const child = await runIslandApplyCli(appRoot, cssSource, undefined, { preloadPath });
  expect(child.exitCode).not.toBe(0);

  const journal = JSON.parse(await fs.readFile(paths.transactionJournalPath, 'utf8')) as {
    phase: string;
    entries: Array<{ stagedPath?: string }>;
  };
  const stagedPath = journal.entries.find(
    ({ stagedPath: candidate }) => candidate !== undefined
  )?.stagedPath;
  expect(journal.phase).toBe('preparing');
  expect(stagedPath).toBeDefined();
  expect(await fs.readFile(stagedPath!, 'utf8')).not.toContain(TYRIAN_MARKER_START);

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'transaction-pending',
    transaction: { kind: 'recoverable', recoverability: 'automatic', version: 5 },
  });
  await expect(
    readIslandShellApplyReadiness({
      appRoot,
      cssSourcePath: cssSource,
      themeVersion: 'test',
      registryHome,
    })
  ).resolves.toMatchObject({ kind: 'ready' });
  await expect(
    applyIslandUiSupervised({
      appRoot,
      cssSourcePath: cssSource,
      themeVersion: 'test',
      registryHome,
    })
  ).resolves.toMatchObject({ kind: 'applied' });
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toContain(TYRIAN_MARKER_START);
  await expect(fs.lstat(paths.transactionJournalPath)).rejects.toThrow();
});

test('verified cleanup preserves a replacement staged generation and reports the completed physical mutation', async () => {
  const appRoot = await createAppRoot('verified-cleanup-replacement');
  const cssSource = path.join(testRoot, 'verified-cleanup-replacement.css');
  const paths = buildIslandPatchPaths(appRoot);
  const foreignContent = 'foreign staged generation\n';
  const originalReadFile = fs.readFile;
  const originalRename = fs.rename;
  let replacementPath: string | undefined;
  await fs.writeFile(cssSource, '.monaco-workbench { color: violet; }\n', 'utf8');

  fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
    const [filePath] = args;
    const operationPath = String(filePath);
    if (
      replacementPath === undefined &&
      path.basename(operationPath).includes('-stage-') &&
      (await originalReadFile(paths.transactionJournalPath, 'utf8')).includes('"phase": "verified"')
    ) {
      replacementPath = path.join(paths.workbenchDirPath, path.basename(operationPath));
      const injectedPath = `${replacementPath}.external`;
      await fs.writeFile(injectedPath, foreignContent, 'utf8');
      await originalRename(injectedPath, replacementPath);
    }
    return originalReadFile(...args);
  }) as typeof fs.readFile;

  try {
    await expect(
      applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome })
    ).rejects.toMatchObject({
      changed: true,
      physicalChanged: true,
      externalDrift: true,
      incompleteRecovery: true,
    });
  } finally {
    fs.readFile = originalReadFile;
  }

  expect(replacementPath).toBeDefined();
  expect(await fs.readFile(replacementPath!, 'utf8')).toBe(foreignContent);
  expect((await fs.lstat(paths.transactionJournalPath)).isFile()).toBe(true);
});

test('SIGKILL before or after atomic exchange leaves each app target at a complete generation', async () => {
  for (const phase of ['before-exchange', 'after-exchange'] as const) {
    const appRoot = await createAppRoot(`sigkill-${phase}`);
    const paths = buildIslandPatchPaths(appRoot);
    const cssSource = path.join(testRoot, `sigkill-${phase}.css`);
    const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
    await fs.writeFile(cssSource, '.monaco-workbench { color: crimson; }\n', 'utf8');
    const fakeMvDirectory = await writeIslandTestMv(phase);

    const child = await runIslandApplyCli(appRoot, cssSource, fakeMvDirectory);
    expect(child.exitCode).not.toBe(0);

    const journal = JSON.parse(await fs.readFile(paths.transactionJournalPath, 'utf8')) as {
      entries: Array<{ filePath: string; stagedPath?: string }>;
    };
    const htmlEntry = journal.entries.find(({ filePath }) => filePath === paths.workbenchHtmlPath);
    const stagedHtml = await fs.readFile(htmlEntry!.stagedPath!, 'utf8');
    expect(stagedHtml).toContain(TYRIAN_MARKER_START);
    expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(
      phase === 'before-exchange' ? originalHtml : stagedHtml
    );
    expect(await fs.readFile(paths.productJsonPath, 'utf8')).toBe(
      await fs.readFile(paths.backupProductJsonPath, 'utf8')
    );
    await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
      transaction: {
        kind: 'recoverable',
        version: 5,
        recoverability: 'automatic',
      },
    });

    await restoreIslandShell({ appRoot, registryHome });
    expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(originalHtml);
    await expect(fs.lstat(paths.transactionJournalPath)).rejects.toThrow();
  }
});

test('repeated recovery revokes each delayed helper source and never reuses an earlier attempt', async () => {
  const appRoot = await createAppRoot('delayed-recovery-exchange');
  const paths = buildIslandPatchPaths(appRoot);
  const cssSource = path.join(testRoot, 'delayed-recovery-exchange.css');
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  await fs.writeFile(cssSource, '.monaco-workbench { color: orchid; }\n', 'utf8');

  const publishKillDirectory = await writeIslandTestMv('after-exchange');
  const initial = await runIslandApplyCli(appRoot, cssSource, publishKillDirectory);
  expect(initial.exitCode).not.toBe(0);
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toContain(TYRIAN_MARKER_START);

  const recoveryKillDirectory = await writeIslandTestMv('wait-for-revocation');
  const attempts: Array<{ pid: number; id: string; sourcePath: string; resultPath: string }> = [];
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const waitingPath = path.join(testRoot, `delayed-recovery-${attempt}.waiting.json`);
      const resultPath = path.join(testRoot, `delayed-recovery-${attempt}.result`);
      const interruptedRecovery = await runIslandRestoreCli(appRoot, recoveryKillDirectory, {
        waitingPath,
        resultPath,
      });
      expect(interruptedRecovery.exitCode).not.toBe(0);
      const waiting = JSON.parse(await waitForIslandTestFile(waitingPath)) as {
        pid: number;
        source: string;
      };
      const journal = JSON.parse(await fs.readFile(paths.transactionJournalPath, 'utf8')) as {
        recovery: { id: string; previousId?: string; phase: string };
        entries: Array<{ filePath: string; publicationPath?: string }>;
      };
      const previousAttempt = attempts.at(-1);
      attempts.push({
        pid: waiting.pid,
        id: journal.recovery.id,
        sourcePath: path.join(paths.workbenchDirPath, path.basename(waiting.source)),
        resultPath,
      });
      expect(journal.recovery).toMatchObject({ phase: 'ready' });
      expect(journal.recovery.previousId).toBe(previousAttempt?.id);
      expect(new Set(attempts.map(({ id }) => id)).size).toBe(attempts.length);
      if (previousAttempt !== undefined) {
        await expect(fs.lstat(previousAttempt.sourcePath)).rejects.toThrow();
        expect(Number(await waitForIslandTestFile(previousAttempt.resultPath))).not.toBe(0);
      }
      const workbenchEntry = journal.entries.find(
        ({ filePath }) => filePath === paths.workbenchHtmlPath
      );
      expect(workbenchEntry?.publicationPath).toBeDefined();
      await expect(fs.lstat(workbenchEntry!.publicationPath!)).rejects.toThrow();
      await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
        transaction: { kind: 'recoverable', recoverability: 'automatic', version: 5 },
      });
    }

    await restoreIslandShell({ appRoot, registryHome });
    expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(originalHtml);
    for (const attempt of attempts) {
      expect(Number(await waitForIslandTestFile(attempt.resultPath))).not.toBe(0);
      await expect(fs.lstat(attempt.sourcePath)).rejects.toThrow();
    }
    await expect(fs.lstat(paths.transactionJournalPath)).rejects.toThrow();
  } finally {
    for (const { pid } of attempts) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
});

test('Restore without exchange preserves a pending v5 transaction before any recovery or desired-state mutation', async () => {
  const appRoot = await createAppRoot('pending-v5-without-exchange');
  const paths = buildIslandPatchPaths(appRoot);
  const cssSource = path.join(testRoot, 'pending-v5-without-exchange.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: coral; }\n', 'utf8');
  const interrupted = await runIslandApplyCli(
    appRoot,
    cssSource,
    await writeIslandTestMv('after-exchange')
  );
  expect(interrupted.exitCode).not.toBe(0);
  const captureEvidence = async () => {
    const evidence = [];
    for (const directory of [
      appRoot,
      paths.workbenchDirPath,
      buildManagedRootsDirectoryPath(registryHome),
    ]) {
      for (const name of (await fs.readdir(directory)).sort()) {
        const filePath = path.join(directory, name);
        // The locked admission may reclaim the killed writer's process lock.
        if (filePath === buildIslandRootLockPath(appRoot)) continue;
        const stats = await fs.lstat(filePath);
        evidence.push({
          filePath,
          device: String(stats.dev),
          inode: String(stats.ino),
          bytes: stats.isFile() ? (await fs.readFile(filePath)).toString('hex') : undefined,
        });
      }
    }
    return evidence;
  };
  const before = await captureEvidence();

  const restored = await runIslandRestoreCli(
    appRoot,
    await writeIslandTestMv('unsupported-exchange'),
    {
      waitingPath: path.join(testRoot, 'unused-waiting'),
      resultPath: path.join(testRoot, 'unused-result'),
    }
  );

  expect(restored.exitCode).not.toBe(0);
  expect(JSON.parse(restored.stderr.trim())).toMatchObject({
    code: 'unsupported',
    reason: expect.stringContaining('pending v5 transaction'),
    changed: false,
    physicalChanged: false,
    desiredStateChanged: false,
    registryChanged: false,
    incompleteRecovery: true,
  });
  expect(await captureEvidence()).toEqual(before);
});

test('a later locked owner retries a SIGKILL-interrupted journal deletion from its predecessor', async () => {
  const appRoot = await createAppRoot('journal-removal-recovery');
  const paths = buildIslandPatchPaths(appRoot);
  const cssSource = path.join(testRoot, 'journal-removal-recovery.css');
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const preloadPath = await writeIslandJournalRemovalKillPreload();
  const predecessor = durableMetadataTestPaths(paths.transactionJournalPath);
  await fs.writeFile(cssSource, '.monaco-workbench { color: salmon; }\n', 'utf8');

  const child = await runIslandApplyCli(appRoot, cssSource, undefined, { preloadPath });
  expect(child.exitCode).not.toBe(0);
  await expect(fs.lstat(paths.transactionJournalPath)).rejects.toThrow();
  expect((await fs.lstat(predecessor.retiredPath)).isFile()).toBe(true);
  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'transaction-pending',
    transaction: { kind: 'recoverable', recoverability: 'automatic' },
  });

  await restoreIslandShell({ appRoot, registryHome });

  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(originalHtml);
  for (const evidencePath of [paths.transactionJournalPath, predecessor.retiredPath]) {
    await expect(fs.lstat(evidencePath)).rejects.toThrow();
  }
});

test('status exposes corrupt transaction evidence before mutation blocks', async () => {
  const appRoot = await createAppRoot('corrupt-journal');
  const { transactionJournalPath } = buildIslandPatchPaths(appRoot);
  await fs.writeFile(transactionJournalPath, '{ broken journal\n', 'utf8');

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'transaction-blocked',
    transaction: {
      kind: 'corrupt',
      recoverability: 'manual',
      reason: expect.stringContaining('invalid JSON'),
    },
  });
  await expect(restoreIslandShell({ appRoot, registryHome })).rejects.toThrow(
    'Tyrian file transaction journal is invalid JSON'
  );
});

test('legacy random journal retirement evidence stays manual and preserves application files', async () => {
  const appRoot = await createAppRoot('legacy-journal-retirement');
  const paths = buildIslandPatchPaths(appRoot);
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const legacyPath = legacyDurableRemovalPath(paths.transactionJournalPath);
  await fs.writeFile(legacyPath, '{ legacy journal retirement\n', 'utf8');

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'transaction-blocked',
    transaction: {
      recoverability: 'manual',
      reason: expect.stringContaining('legacy unproved deletion evidence'),
    },
  });
  await expect(restoreIslandShell({ appRoot, registryHome })).rejects.toThrow(
    'legacy unproved deletion evidence'
  );
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(originalHtml);
  expect(await fs.readFile(legacyPath, 'utf8')).toBe('{ legacy journal retirement\n');
});

test('Doctor preserves legacy random sealed sidecar retirement evidence', async () => {
  const appRoot = await createAppRoot('legacy-sidecar-retirement');
  const paths = buildIslandPatchPaths(appRoot);
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const originalStats = await fs.lstat(paths.workbenchHtmlPath);
  const desiredHtml = `${originalHtml}\n<!-- sealed desired generation -->\n`;
  const id = crypto.randomUUID();
  const backupPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'backup');
  const stagedPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'stage');
  const publicationPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'publication');
  const legacyStagedPath = legacyDurableRemovalPath(stagedPath);
  await fs.copyFile(paths.workbenchHtmlPath, backupPath);
  await fs.writeFile(stagedPath, desiredHtml, 'utf8');
  await fs.chmod(stagedPath, originalStats.mode);
  await fs.link(stagedPath, publicationPath);
  await fs.rename(stagedPath, legacyStagedPath);
  await fs.writeFile(
    paths.transactionJournalPath,
    JSON.stringify(
      {
        version: 5,
        id,
        appRoot,
        phase: 'prepared',
        entries: [
          {
            filePath: paths.workbenchHtmlPath,
            backupPath,
            stagedPath,
            publicationPath,
            existed: true,
            originalChecksum: sha256Base64(originalHtml),
            desiredChecksum: sha256Base64(desiredHtml),
            originalMode: Number(originalStats.mode),
            originalDevice: String(originalStats.dev),
            originalInode: String(originalStats.ino),
          },
        ],
      },
      null,
      2
    ).concat('\n'),
    'utf8'
  );

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'transaction-blocked',
    transaction: {
      recoverability: 'manual',
      reason: expect.stringContaining('legacy unproved deletion evidence'),
    },
  });
  await expect(restoreIslandShell({ appRoot, registryHome })).rejects.toThrow(
    'legacy unproved deletion evidence'
  );
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(originalHtml);
  expect(await fs.readFile(legacyStagedPath, 'utf8')).toBe(desiredHtml);
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
    JSON.stringify({ version: 2, appRoot, desiredThemeId: null }, null, 2).concat('\n'),
    'utf8'
  );
  return recordPath;
}

async function currentLockProcessIdentity(): Promise<string | null> {
  if (process.platform !== 'linux') return null;

  const [bootId, stat] = await Promise.all([
    fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    fs.readFile(`/proc/${process.pid}/stat`, 'utf8'),
  ]);
  const commandEnd = stat.lastIndexOf(')');
  const startTime =
    commandEnd === -1
      ? undefined
      : stat
          .slice(commandEnd + 1)
          .trim()
          .split(/\s+/u)[19];

  return bootId.trim() && startTime ? `${bootId.trim()}:${startTime}` : null;
}

async function expectOnlyWorkbenchHtmlSidecarRemains(appRoot: string): Promise<void> {
  const paths = buildIslandPatchPaths(appRoot);

  await expect(fs.readdir(paths.workbenchDirPath)).resolves.toEqual([
    path.basename(paths.workbenchHtmlPath),
  ]);
}

function transactionTemporaryPath(
  filePath: string,
  transactionId: string,
  kind: 'backup' | 'stage' | 'retired' | 'publication'
): string {
  return path.join(
    path.dirname(filePath),
    `.tyrian-night-${transactionId}-${kind}-${path.basename(filePath)}.tmp`
  );
}

function durableMetadataTestPaths(filePath: string): { retiredPath: string } {
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  return {
    retiredPath: path.join(directory, `.tyrian-night-retired-${baseName}.tmp`),
  };
}

function legacyDurableRemovalPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.tyrian-night-${crypto.randomUUID()}-retired-${path.basename(filePath)}.tmp`
  );
}

type IslandTestMvMode =
  | 'before-exchange'
  | 'after-exchange'
  | 'external-replacement'
  | 'ancestor-swap'
  | 'wait-for-revocation'
  | 'unsupported-exchange';

async function writeIslandTestMv(mode: IslandTestMvMode): Promise<string> {
  const directory = path.join(testRoot, `fake-mv-${mode}-${crypto.randomUUID()}`);
  await fs.mkdir(directory);
  const scriptPath = path.join(directory, 'mv');
  const script = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const mode = process.env.TYRIAN_TEST_MV_MODE;
if (args.length === 1 && args[0] === '--help') {
  if (mode === 'unsupported-exchange') {
    process.stdout.write('usage: mv\\n');
    process.exit(0);
  }
  process.stdout.write('--exchange\\n--no-copy\\n--no-target-directory\\n');
  process.exit(0);
}
if (args.includes('--exchange')) {
  if (mode === 'before-exchange') {
    process.kill(process.ppid, 'SIGKILL');
    process.exit(0);
  }
  if (mode === 'external-replacement') {
    const targetPath = process.env.TYRIAN_TEST_TARGET_PATH;
    if (!targetPath) throw new Error('missing external replacement target');
    const externalPath = targetPath.concat('.external');
    await fs.writeFile(externalPath, process.env.TYRIAN_TEST_REPLACEMENT ?? '', 'utf8');
    const externalStats = await fs.lstat(externalPath);
    await fs.writeFile(targetPath.concat('.external-identity.json'), JSON.stringify({
      device: String(externalStats.dev), inode: String(externalStats.ino),
    }), 'utf8');
    await fs.rename(externalPath, targetPath);
  }
  if (mode === 'ancestor-swap') {
    const workbenchDirectory = process.env.TYRIAN_TEST_WORKBENCH_DIRECTORY;
    const displacedWorkbench = process.env.TYRIAN_TEST_DISPLACED_WORKBENCH;
    const externalWorkbench = process.env.TYRIAN_TEST_EXTERNAL_WORKBENCH;
    if (!workbenchDirectory || !displacedWorkbench || !externalWorkbench) {
      throw new Error('missing ancestor-swap paths');
    }
    await fs.rename(workbenchDirectory, displacedWorkbench);
    await fs.symlink(externalWorkbench, workbenchDirectory, 'dir');
  }
  if (mode === 'wait-for-revocation') {
    const source = args.at(-2);
    const waitingPath = process.env.TYRIAN_TEST_WAITING_PATH;
    const resultPath = process.env.TYRIAN_TEST_RESULT_PATH;
    if (!source || !waitingPath || !resultPath) throw new Error('missing delayed-exchange paths');
    process.kill(process.ppid, 'SIGKILL');
    await fs.writeFile(waitingPath.concat('.next'), JSON.stringify({ pid: process.pid, source }), 'utf8');
    await fs.rename(waitingPath.concat('.next'), waitingPath);
    while (true) {
      try {
        await fs.lstat(source);
        await delay(10);
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
          throw error;
        }
        break;
      }
    }
    const delayed = spawnSync(process.env.TYRIAN_TEST_REAL_MV ?? '/usr/bin/mv', args, {
      stdio: ['ignore', 'ignore', 'ignore', 3, 4],
    });
    await fs.writeFile(resultPath.concat('.next'), String(delayed.status ?? 1), 'utf8');
    await fs.rename(resultPath.concat('.next'), resultPath);
    process.exit(delayed.status ?? 1);
  }
  const result = spawnSync(process.env.TYRIAN_TEST_REAL_MV ?? '/usr/bin/mv', args, {
    stdio: ['inherit', 'inherit', 'inherit', 3, 4],
  });
  if (mode === 'after-exchange' && result.status === 0) {
    process.kill(process.ppid, 'SIGKILL');
  }
  process.exit(result.status ?? 1);
}
const result = spawnSync(process.env.TYRIAN_TEST_REAL_MV ?? '/usr/bin/mv', args, {
  stdio: ['inherit', 'inherit', 'inherit', 3, 4],
});
process.exit(result.status ?? 1);
`;
  await fs.writeFile(scriptPath, script, 'utf8');
  await fs.chmod(scriptPath, 0o755);
  return directory;
}

async function runIslandApplyCli(
  appRoot: string,
  cssSourcePath: string,
  fakeMvDirectory: string | undefined,
  options: {
    targetPath?: string;
    replacement?: string;
    workbenchDirectory?: string;
    displacedWorkbench?: string;
    externalWorkbench?: string;
    preloadPath?: string;
    waitingPath?: string;
    resultPath?: string;
  } = {}
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const command = [process.execPath];
  if (options.preloadPath !== undefined) command.push('--preload', options.preloadPath);
  command.push(
    path.resolve('apps/vscode/src/islandCli.ts'),
    'apply',
    '--app-root',
    appRoot,
    '--css-source',
    cssSourcePath,
    '--theme-version',
    'test'
  );
  const child = Bun.spawn(command, {
    env: {
      ...process.env,
      HOME: registryHome,
      PATH: [fakeMvDirectory, process.env.PATH].filter(Boolean).join(path.delimiter),
      TYRIAN_TEST_MV_MODE:
        fakeMvDirectory === undefined ? undefined : islandTestMvModeFromDirectory(fakeMvDirectory),
      TYRIAN_TEST_TARGET_PATH: options.targetPath,
      TYRIAN_TEST_REPLACEMENT: options.replacement,
      TYRIAN_TEST_WORKBENCH_DIRECTORY: options.workbenchDirectory,
      TYRIAN_TEST_DISPLACED_WORKBENCH: options.displacedWorkbench,
      TYRIAN_TEST_EXTERNAL_WORKBENCH: options.externalWorkbench,
      TYRIAN_TEST_WAITING_PATH: options.waitingPath,
      TYRIAN_TEST_RESULT_PATH: options.resultPath,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function runIslandRestoreCli(
  appRoot: string,
  fakeMvDirectory: string,
  options: { waitingPath: string; resultPath: string }
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    [
      process.execPath,
      path.resolve('apps/vscode/src/islandCli.ts'),
      'restore',
      '--app-root',
      appRoot,
    ],
    {
      env: {
        ...process.env,
        HOME: registryHome,
        PATH: [fakeMvDirectory, process.env.PATH].filter(Boolean).join(path.delimiter),
        TYRIAN_TEST_MV_MODE: islandTestMvModeFromDirectory(fakeMvDirectory),
        TYRIAN_TEST_WAITING_PATH: options.waitingPath,
        TYRIAN_TEST_RESULT_PATH: options.resultPath,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function waitForIslandTestFile(filePath: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      await delay(10);
    }
  }
  throw new Error(`Timed out waiting for Island test process evidence at '${filePath}'.`);
}

async function writeIslandPreparingStageKillPreload(): Promise<string> {
  const preloadPath = path.join(testRoot, 'kill-island-preparing-stage.ts');
  await fs.writeFile(
    preloadPath,
    [
      "import fs from 'node:fs/promises';",
      'const open = fs.open.bind(fs);',
      'fs.open = async (...args) => {',
      '  const handle = await open(...args);',
      "  if (String(args[0]).includes('-stage-') && args[1] === 'wx') {",
      '    handle.writeFile = async (content) => {',
      "      await handle.write(String(content).slice(0, 1), 'utf8');",
      "      process.kill(process.pid, 'SIGKILL');",
      '    };',
      '  }',
      '  return handle;',
      '};',
      '',
    ].join('\n'),
    'utf8'
  );
  return preloadPath;
}

async function writeIslandJournalRemovalKillPreload(): Promise<string> {
  const preloadPath = path.join(testRoot, 'kill-island-journal-removal.ts');
  await fs.writeFile(
    preloadPath,
    [
      "import path from 'node:path';",
      "import fs from 'node:fs/promises';",
      'const rename = fs.rename.bind(fs);',
      'let killed = false;',
      'fs.rename = async (sourcePath, targetPath) => {',
      '  const result = await rename(sourcePath, targetPath);',
      "  if (!killed && path.basename(String(sourcePath)) === 'tyrian-night.transaction.json' && path.basename(String(targetPath)) === '.tyrian-night-retired-tyrian-night.transaction.json.tmp') {",
      '    killed = true;',
      "    process.kill(process.pid, 'SIGKILL');",
      '  }',
      '  return result;',
      '};',
      '',
    ].join('\n'),
    'utf8'
  );
  return preloadPath;
}

function islandTestMvModeFromDirectory(directory: string): IslandTestMvMode {
  const name = path.basename(directory);
  const mode = [
    'before-exchange',
    'after-exchange',
    'external-replacement',
    'ancestor-swap',
    'wait-for-revocation',
    'unsupported-exchange',
  ].find((candidate) => name.startsWith(`fake-mv-${candidate}-`));
  if (mode === undefined) throw new Error(`Unknown Island test mv directory '${directory}'.`);
  return mode as IslandTestMvMode;
}
