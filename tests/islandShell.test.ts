import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
  buildLegacyManagedRootsRegistryPath,
  buildLegacyRetirementMarkerPath,
  buildManagedRootRecordPath,
  buildManagedRootsDirectoryPath,
} from '../apps/vscode/src/islandPatchContract';
import {
  IslandRegistryQuarantineError,
  moveRegistryRecordToQuarantineCore,
} from '../apps/vscode/src/islandRegistryMutationCore';

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
  await expect(fs.stat(buildLegacyRetirementMarkerPath(registryHome))).rejects.toThrow();
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
    await expect(fs.stat(buildLegacyRetirementMarkerPath(registryHome))).rejects.toThrow();
  } finally {
    await fs.chmod(unreadablePath, 0o644);
  }
});

test('legacy registry transaction journals are read-only manual recovery evidence', async () => {
  const directoryPath = buildManagedRootsDirectoryPath(registryHome);
  const journalPath = path.join(directoryPath, `.tyrian-night-journal-${'a'.repeat(64)}.json`);
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(journalPath, '{ preserved legacy registry transaction }\n', 'utf8');

  const inventory = await readAllIslandShellStatusesWithDiagnostics({ registryHome });
  expect(inventory.statuses).toEqual([]);
  expect(inventory.registryDiagnostics).toEqual([
    expect.stringContaining('unsupported legacy registry transaction journal'),
  ]);
  expect(await fs.readFile(journalPath, 'utf8')).toBe(
    '{ preserved legacy registry transaction }\n'
  );

  const cleanup = await restoreAllIslandShells({ registryHome });
  expect(cleanup).toMatchObject({
    changed: true,
    registryChanged: true,
    incompleteRecovery: true,
    enumerationFailure: {
      code: 'unsupported',
      reason: expect.stringContaining('manual recovery'),
    },
  });
  expect(await fs.readFile(journalPath, 'utf8')).toBe(
    '{ preserved legacy registry transaction }\n'
  );
});

test('raw restore-all exits nonzero while preserving its incomplete machine-readable summary', async () => {
  await writeLegacyManagedRootsRegistryContent('{ invalid legacy registry\n');
  const child = Bun.spawn(
    [process.execPath, path.resolve('apps/vscode/src/islandCli.ts'), 'restore-all'],
    {
      env: { ...process.env, HOME: registryHome },
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

  expect(exitCode).toBe(2);
  expect(stderr).toBe('');
  expect(JSON.parse(stdout)).toMatchObject({
    failedAppRoots: [],
    enumerationFailure: {
      reason: expect.stringContaining('invalid JSON'),
    },
  });
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
      version: 1,
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
    canSelfHeal: true,
  });
  expect(await fs.readFile(recordPath, 'utf8')).toBe(before);
});

test('status-all fails loudly when the managed root registry is corrupt', async () => {
  await writeLegacyManagedRootsRegistryContent('{ broken registry\n');

  await expect(readAllIslandShellStatuses({ registryHome })).rejects.toThrow(
    'Tyrian managed app roots registry is invalid JSON'
  );
});

test('status-all fails loudly when the managed root registry contains empty roots', async () => {
  await writeLegacyManagedRootsRegistry(['']);

  await expect(readAllIslandShellStatuses({ registryHome })).rejects.toThrow(
    'every app root must be an absolute non-empty string'
  );
});

test('status-all fails loudly when the managed root registry file is empty', async () => {
  await writeLegacyManagedRootsRegistryContent('');

  await expect(readAllIslandShellStatuses({ registryHome })).rejects.toThrow(
    'Tyrian managed app roots registry is invalid JSON'
  );
});

test('status-all fails loudly when the managed root registry contains no roots', async () => {
  await writeLegacyManagedRootsRegistryContent(
    JSON.stringify({ version: 1, appRoots: [] }, null, 2).concat('\n')
  );

  await expect(readAllIslandShellStatuses({ registryHome })).rejects.toThrow(
    'expected at least one app root or no registry file'
  );
});

test('status-all projects the legacy root list without migrating it', async () => {
  const firstRoot = path.join(testRoot, 'legacy-first');
  const secondRoot = path.join(testRoot, 'legacy-second');
  const legacyPath = await writeLegacyManagedRootsRegistry([firstRoot, secondRoot, firstRoot]);

  const statusSets = await Promise.all(
    Array.from({ length: 8 }, () => readAllIslandShellStatuses({ registryHome }))
  );

  for (const statuses of statusSets) {
    expect(statuses.map(({ appRoot }) => appRoot)).toEqual([firstRoot, secondRoot]);
  }
  expect((await fs.stat(legacyPath)).isFile()).toBe(true);
  await expect(fs.stat(`${legacyPath}.migrating`)).rejects.toThrow();
  await expect(fs.stat(buildManagedRootsDirectoryPath(registryHome))).rejects.toThrow();
});

test('status-all combines current and legacy roots without retiring either source', async () => {
  const currentRoot = path.join(testRoot, 'current-root');
  const legacyOnlyRoot = path.join(testRoot, 'legacy-only-root');
  await writeManagedRootRecord(currentRoot);
  const legacyPath = await writeLegacyManagedRootsRegistry([currentRoot, legacyOnlyRoot]);

  expect(
    (await readAllIslandShellStatuses({ registryHome })).map(({ appRoot }) => appRoot)
  ).toEqual([currentRoot, legacyOnlyRoot]);
  expect((await fs.stat(legacyPath)).isFile()).toBe(true);
});

test('the retirement marker prevents a recreated legacy list from reviving a removed root', async () => {
  const appRoot = path.join(testRoot, 'retired-root');
  const legacyPath = await writeLegacyManagedRootsRegistry([appRoot]);

  await readAllIslandShellStatuses({ registryHome });
  await restoreAllIslandShells({ registryHome });
  await writeLegacyManagedRootsRegistry([appRoot]);

  await expect(readAllIslandShellStatuses({ registryHome })).resolves.toEqual([]);
  expect((await fs.stat(legacyPath)).isFile()).toBe(true);
  expect((await fs.stat(buildLegacyRetirementMarkerPath(registryHome))).isFile()).toBe(true);
});

test('status-all projects both legacy snapshots without claiming either', async () => {
  const snapshottedRoot = path.join(testRoot, 'snapshotted-root');
  const concurrentlyWrittenRoot = path.join(testRoot, 'concurrently-written-root');
  const legacyPath = await writeLegacyManagedRootsRegistry([snapshottedRoot]);
  await fs.copyFile(legacyPath, `${legacyPath}.migrating`);
  await writeLegacyManagedRootsRegistry([snapshottedRoot, concurrentlyWrittenRoot]);

  expect(
    (await readAllIslandShellStatuses({ registryHome })).map(({ appRoot }) => appRoot)
  ).toEqual([concurrentlyWrittenRoot, snapshottedRoot]);
  expect((await fs.stat(legacyPath)).isFile()).toBe(true);
  expect((await fs.stat(`${legacyPath}.migrating`)).isFile()).toBe(true);
});

test('status-all combines published records with an unclaimed migration snapshot', async () => {
  const publishedRoot = path.join(testRoot, 'published-root');
  const snapshottedRoot = path.join(testRoot, 'unpublished-snapshot-root');
  await writeManagedRootRecord(publishedRoot);
  const legacyPath = await writeLegacyManagedRootsRegistry([snapshottedRoot]);
  const migrationPath = `${legacyPath}.migrating`;
  await fs.copyFile(legacyPath, migrationPath);

  expect(
    (await readAllIslandShellStatuses({ registryHome })).map(({ appRoot }) => appRoot)
  ).toEqual([publishedRoot, snapshottedRoot]);
  expect((await fs.stat(migrationPath)).isFile()).toBe(true);
});

test('migrated roots become durably disabled without reviving the legacy authority', async () => {
  const appRoot = await createAppRoot('migrated-unregister');
  const cssSource = path.join(testRoot, 'migrated-theme.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: cyan; }\n', 'utf8');
  await writeLegacyManagedRootsRegistry([appRoot]);
  await readAllIslandShellStatuses({ registryHome });
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });

  await restoreIslandShell({ appRoot, registryHome });

  await expect(readAllIslandShellStatuses({ registryHome })).resolves.toMatchObject([
    { appRoot, registrationState: 'valid', desiredThemeId: null, classification: 'clean' },
  ]);
});

test('legacy migration reports a record written before a later collision', async () => {
  const firstRoot = path.join(testRoot, 'partial-migration-a-first');
  const collidingRoot = path.join(testRoot, 'partial-migration-z-collision');
  await fs.mkdir(firstRoot);
  await fs.mkdir(collidingRoot);
  await writeLegacyManagedRootsRegistry([firstRoot, collidingRoot]);
  const collisionPath = buildManagedRootRecordPath(collidingRoot, registryHome);
  await fs.mkdir(path.dirname(collisionPath), { recursive: true });
  await fs.writeFile(
    collisionPath,
    JSON.stringify({ version: 1, appRoot: firstRoot }, null, 2).concat('\n'),
    'utf8'
  );

  const result = await restoreAllIslandShells({ registryHome });

  expect(result).toMatchObject({
    changed: true,
    registryChanged: true,
    enumerationFailure: {
      changed: true,
      registryChanged: true,
      reason: expect.stringContaining('hash collision'),
    },
  });
  expect(
    JSON.parse(await fs.readFile(buildManagedRootRecordPath(firstRoot, registryHome), 'utf8'))
  ).toEqual({ version: 1, appRoot: firstRoot });
});

test('legacy migration rejects symlinked owned inputs without consuming their targets', async () => {
  const cases = [
    'retirement marker',
    'legacy registry',
    'migration snapshot',
    'hashed record',
  ] as const;

  for (const kind of cases) {
    const caseHome = path.join(testRoot, `symlinked-${kind.replaceAll(' ', '-')}`);
    const appRoot = path.join(testRoot, `symlinked-${kind.replaceAll(' ', '-')}-root`);
    const externalPath = path.join(testRoot, `external-${kind.replaceAll(' ', '-')}.json`);
    const legacyPath = buildLegacyManagedRootsRegistryPath(caseHome);
    const migrationPath = `${legacyPath}.migrating`;
    const retirementPath = buildLegacyRetirementMarkerPath(caseHome);
    const recordPath = buildManagedRootRecordPath(appRoot, caseHome);
    let ownedPath: string;
    let externalContent: string;

    if (kind === 'retirement marker') {
      ownedPath = retirementPath;
      externalContent = JSON.stringify({ version: 1, retiredAt: new Date().toISOString() });
    } else if (kind === 'hashed record') {
      await fs.mkdir(appRoot, { recursive: true });
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        JSON.stringify({ version: 1, appRoots: [appRoot] }).concat('\n'),
        'utf8'
      );
      ownedPath = recordPath;
      externalContent = JSON.stringify({ version: 1, appRoot }).concat('\n');
    } else {
      ownedPath = kind === 'legacy registry' ? legacyPath : migrationPath;
      externalContent = JSON.stringify({ version: 1, appRoots: [appRoot] }).concat('\n');
    }

    await fs.mkdir(path.dirname(ownedPath), { recursive: true });
    await fs.writeFile(externalPath, externalContent, 'utf8');
    await fs.symlink(externalPath, ownedPath);

    const result = await restoreAllIslandShells({ registryHome: caseHome });

    expect(result.enumerationFailure?.reason).toContain('not an owned regular file');
    expect((await fs.lstat(ownedPath)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(externalPath, 'utf8')).toBe(externalContent);
  }
});

test('legacy migration rejects an identity change during an owned input read', async () => {
  const appRoot = path.join(testRoot, 'legacy-read-identity-root');
  await fs.mkdir(appRoot);
  const legacyPath = await writeLegacyManagedRootsRegistry([appRoot]);
  const replacementPath = path.join(path.dirname(legacyPath), 'legacy-replacement.json');
  const content = await fs.readFile(legacyPath, 'utf8');
  await fs.writeFile(replacementPath, content, 'utf8');
  const originalReadFile = fs.readFile;
  const originalRename = fs.rename;
  let injected = false;

  fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
    const result = await originalReadFile(...args);
    const [filePath] = args;
    if (!injected && String(filePath) === legacyPath) {
      injected = true;
      await originalRename(replacementPath, legacyPath);
    }
    return result;
  }) as typeof fs.readFile;

  let result: Awaited<ReturnType<typeof restoreAllIslandShells>>;
  try {
    result = await restoreAllIslandShells({ registryHome });
  } finally {
    fs.readFile = originalReadFile;
  }

  expect(injected).toBe(true);
  expect(result).toMatchObject({
    changed: true,
    registryChanged: true,
    externalDrift: true,
    incompleteRecovery: true,
    enumerationFailure: {
      externalDrift: true,
      reason: expect.stringContaining('changed during inspection'),
    },
  });
  expect(await fs.readFile(legacyPath, 'utf8')).toBe(content);
});

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
});

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

test('transaction retirement preserves a replacement generation at the final leaf boundary', async () => {
  const appRoot = await createAppRoot('replacement-at-retirement');
  const cssSource = path.join(testRoot, 'replacement-at-retirement.css');
  const paths = buildIslandPatchPaths(appRoot);
  const replacement = 'external replacement generation\n';
  const originalRename = fs.rename;
  let injected = false;
  await fs.writeFile(cssSource, '.monaco-workbench { color: red; }\n', 'utf8');

  fs.rename = (async (sourcePath, targetPath) => {
    if (
      !injected &&
      path.basename(String(sourcePath)) === path.basename(paths.workbenchHtmlPath) &&
      path.basename(String(targetPath)).includes('-retired-workbench.html.tmp')
    ) {
      injected = true;
      const replacementPath = path.join(paths.workbenchDirPath, 'external-replacement.tmp');
      await fs.writeFile(replacementPath, replacement, 'utf8');
      await originalRename(replacementPath, paths.workbenchHtmlPath);
    }
    return originalRename(sourcePath, targetPath);
  }) as typeof fs.rename;

  try {
    await expect(
      applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome })
    ).rejects.toMatchObject({ externalDrift: true, incompleteRecovery: true });
  } finally {
    fs.rename = originalRename;
  }

  expect(injected).toBe(true);
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(replacement);
  expect((await fs.lstat(paths.transactionJournalPath)).isFile()).toBe(true);
});

test('descriptor-anchored transaction cannot be redirected by an admitted ancestor swap', async () => {
  const appRoot = await createAppRoot('ancestor-swap-at-retirement');
  const cssSource = path.join(testRoot, 'ancestor-swap-at-retirement.css');
  const paths = buildIslandPatchPaths(appRoot);
  const displacedWorkbench = path.join(testRoot, 'displaced-workbench');
  const externalWorkbench = await fs.mkdtemp(
    path.join(os.tmpdir(), 'tyrian-island-ancestor-external-')
  );
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const originalRename = fs.rename;
  let injected = false;
  await fs.writeFile(path.join(externalWorkbench, 'workbench.html'), originalHtml, 'utf8');
  await fs.writeFile(cssSource, '.monaco-workbench { color: red; }\n', 'utf8');

  fs.rename = (async (sourcePath, targetPath) => {
    if (
      !injected &&
      path.basename(String(sourcePath)) === path.basename(paths.workbenchHtmlPath) &&
      path.basename(String(targetPath)).includes('-retired-workbench.html.tmp')
    ) {
      injected = true;
      await originalRename(paths.workbenchDirPath, displacedWorkbench);
      await fs.symlink(externalWorkbench, paths.workbenchDirPath, 'dir');
    }
    return originalRename(sourcePath, targetPath);
  }) as typeof fs.rename;

  try {
    await expect(
      applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome })
    ).rejects.toThrow('patch namespace changed');
  } finally {
    fs.rename = originalRename;
  }

  try {
    expect(injected).toBe(true);
    expect(await fs.readdir(externalWorkbench)).toEqual(['workbench.html']);
    expect(await fs.readFile(path.join(externalWorkbench, 'workbench.html'), 'utf8')).toBe(
      originalHtml
    );
    expect(await fs.readFile(path.join(displacedWorkbench, 'workbench.html'), 'utf8')).toBe(
      originalHtml
    );
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
      version: 1,
      pid: process.pid,
      token: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
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
      version: 1,
      token: crypto.randomUUID(),
      pid: process.pid,
      createdAt: '2000-01-01T00:00:00.000Z',
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
  await writeManagedRootRecord(appRoot);

  const result = await restoreAllIslandShells({ registryHome });

  expect(result.changed).toBe(true);
  expect(result).toMatchObject({
    desiredStateChanged: true,
    registryChanged: true,
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

test('quarantine sync failure preserves the post-rename changed fact and path', async () => {
  const recordDirectory = path.join(testRoot, 'registry');
  const quarantineDirectory = path.join(testRoot, 'quarantine');
  const recordPath = path.join(recordDirectory, 'record.json');
  const quarantinePath = path.join(quarantineDirectory, 'record.json');
  await fs.mkdir(recordDirectory, { recursive: true });
  await fs.mkdir(quarantineDirectory, { recursive: true });
  await fs.writeFile(recordPath, '{ broken\n', 'utf8');

  try {
    await moveRegistryRecordToQuarantineCore({
      recordPath,
      recordDirectory,
      quarantinePath,
      quarantineDirectory,
      rename: fs.rename,
      verifyMovedGeneration: async () => {},
      syncDirectories: async () => {
        throw new Error('injected directory sync failure');
      },
    });
    throw new Error('Expected quarantine durability sync to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(IslandRegistryQuarantineError);
    expect(error).toMatchObject({ changed: true, quarantinePath });
  }
  await expect(fs.stat(recordPath)).rejects.toThrow();
  expect((await fs.stat(quarantinePath)).isFile()).toBe(true);
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
    canSelfHeal: true,
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

test('legacy v2 transaction evidence fails closed without overwriting a newer target', async () => {
  const appRoot = await createAppRoot('interrupted-transaction');
  const cssSource = path.join(testRoot, 'interrupted.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: cyan; }\n', 'utf8');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });

  const paths = buildIslandPatchPaths(appRoot);
  const id = crypto.randomUUID();
  const backupPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'backup');
  const stagedPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'stage');
  await fs.copyFile(paths.workbenchHtmlPath, backupPath);
  await fs.writeFile(stagedPath, 'interrupted staged content\n', 'utf8');
  await fs.writeFile(
    paths.transactionJournalPath,
    JSON.stringify(
      {
        version: 2,
        id,
        appRoot,
        phase: 'prepared',
        entries: [
          {
            filePath: paths.workbenchHtmlPath,
            backupPath,
            stagedPath,
            existed: true,
          },
        ],
      },
      null,
      2
    ).concat('\n'),
    'utf8'
  );
  await fs.writeFile(paths.workbenchHtmlPath, 'partially committed content\n', 'utf8');

  await expect(readAllIslandShellStatuses({ registryHome })).resolves.toMatchObject([
    {
      classification: 'transaction-blocked',
      verificationPassed: false,
      transaction: {
        kind: 'unsupported',
        recoverability: 'manual',
        version: 2,
      },
    },
  ]);
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe('partially committed content\n');
  expect((await fs.stat(paths.transactionJournalPath)).isFile()).toBe(true);

  await expect(
    applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome })
  ).rejects.toMatchObject({
    incompleteRecovery: true,
    physicalChanged: false,
    externalDrift: false,
  });
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe('partially committed content\n');
  expect((await fs.stat(paths.transactionJournalPath)).isFile()).toBe(true);
  expect((await fs.stat(backupPath)).isFile()).toBe(true);
  expect((await fs.stat(stagedPath)).isFile()).toBe(true);
});

test('legacy v1 transaction evidence is also preserved as unsupported', async () => {
  const appRoot = await createAppRoot('legacy-v1-transaction');
  const paths = buildIslandPatchPaths(appRoot);
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const newerHtml = originalHtml.replace('</head>', '<meta name="newer">\n\t</head>');
  const id = crypto.randomUUID();
  const backupPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'backup');
  const stagedPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'stage');
  await fs.writeFile(backupPath, originalHtml, 'utf8');
  await fs.writeFile(stagedPath, 'legacy staged content\n', 'utf8');
  await fs.writeFile(paths.workbenchHtmlPath, newerHtml, 'utf8');
  await fs.writeFile(
    paths.transactionJournalPath,
    JSON.stringify({
      version: 1,
      id,
      phase: 'prepared',
      entries: [
        {
          filePath: paths.workbenchHtmlPath,
          backupPath,
          stagedPath,
          existed: true,
        },
      ],
    }).concat('\n'),
    'utf8'
  );

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'transaction-blocked',
    transaction: { kind: 'unsupported', version: 1 },
  });
  await expect(restoreIslandShell({ appRoot, registryHome })).rejects.toMatchObject({
    incompleteRecovery: true,
    physicalChanged: false,
  });
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(newerHtml);
  expect((await fs.stat(paths.transactionJournalPath)).isFile()).toBe(true);
});

test('transaction recovery never overwrites an externally replaced generation', async () => {
  const appRoot = await createAppRoot('external-drift-recovery');
  await restoreIslandShell({ appRoot, registryHome });
  const paths = buildIslandPatchPaths(appRoot);
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const desiredHtml = originalHtml.replace('</head>', '<meta name="desired">\n\t</head>');
  const externalHtml = originalHtml.replace('</head>', '<meta name="external">\n\t</head>');
  const id = crypto.randomUUID();
  const backupPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'backup');
  const stagedPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'stage');
  await fs.writeFile(backupPath, originalHtml, 'utf8');
  await fs.writeFile(stagedPath, desiredHtml, 'utf8');
  await fs.writeFile(paths.workbenchHtmlPath, externalHtml, 'utf8');
  await fs.writeFile(
    paths.transactionJournalPath,
    JSON.stringify(
      {
        version: 3,
        id,
        appRoot,
        phase: 'committing',
        entries: [
          {
            filePath: paths.workbenchHtmlPath,
            backupPath,
            stagedPath,
            existed: true,
            originalChecksum: sha256Base64(originalHtml),
            desiredChecksum: sha256Base64(desiredHtml),
          },
        ],
      },
      null,
      2
    ).concat('\n'),
    'utf8'
  );

  await expect(restoreIslandShell({ appRoot, registryHome })).rejects.toMatchObject({
    changed: false,
    physicalChanged: false,
    externalDrift: true,
    incompleteRecovery: true,
  });
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(externalHtml);
  expect((await fs.stat(paths.transactionJournalPath)).isFile()).toBe(true);
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

test('v4 recovery restores a target retired before staged publication', async () => {
  const appRoot = await createAppRoot('v4-retire-publication-gap');
  const paths = buildIslandPatchPaths(appRoot);
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const originalStats = await fs.lstat(paths.workbenchHtmlPath);
  const desiredHtml = `${originalHtml}\n<!-- interrupted desired generation -->\n`;
  const id = crypto.randomUUID();
  const backupPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'backup');
  const stagedPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'stage');
  const retiredPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'retired');
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

  await expect(restoreIslandShell({ appRoot, registryHome })).resolves.toMatchObject({
    physicalChanged: true,
  });
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(originalHtml);
  for (const ownedPath of [backupPath, stagedPath, retiredPath, paths.transactionJournalPath]) {
    await expect(fs.lstat(ownedPath)).rejects.toThrow();
  }
});

test('v3 verified cleanup preserves the historical managed-record target path', async () => {
  const appRoot = await createAppRoot('v3-managed-record-cleanup');
  const paths = buildIslandPatchPaths(appRoot);
  const recordPath = buildManagedRootRecordPath(appRoot, registryHome);
  const recordContent = JSON.stringify(
    { version: 2, appRoot, desiredThemeId: null },
    null,
    2
  ).concat('\n');
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, recordContent, 'utf8');
  const id = crypto.randomUUID();
  const backupPath = transactionTemporaryPath(recordPath, id, 'backup');
  await fs.writeFile(backupPath, recordContent, 'utf8');
  await fs.writeFile(
    paths.transactionJournalPath,
    JSON.stringify(
      {
        version: 3,
        id,
        appRoot,
        phase: 'verified',
        entries: [
          {
            filePath: recordPath,
            backupPath,
            existed: true,
            originalChecksum: sha256Base64(recordContent),
            desiredChecksum: sha256Base64(recordContent),
          },
        ],
      },
      null,
      2
    ).concat('\n'),
    'utf8'
  );

  await expect(restoreIslandShell({ appRoot, registryHome })).resolves.toBeDefined();
  expect(await fs.readFile(recordPath, 'utf8')).toBe(recordContent);
  await expect(fs.lstat(backupPath)).rejects.toThrow();
  await expect(fs.lstat(paths.transactionJournalPath)).rejects.toThrow();
});

test('verified cleanup preserves replacement evidence and reports the physical mutation', async () => {
  const appRoot = await createAppRoot('verified-cleanup-replacement');
  const cssSource = path.join(testRoot, 'verified-cleanup-replacement.css');
  await fs.writeFile(cssSource, '.monaco-workbench { color: violet; }\n', 'utf8');
  const originalReadFile = fs.readFile;
  const originalRename = fs.rename;
  const foreignContent = 'foreign staged generation\n';
  let replacementPath: string | undefined;
  const workbenchDirectory = buildIslandPatchPaths(appRoot).workbenchDirPath;

  fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
    const [filePath] = args;
    if (replacementPath === undefined && path.basename(String(filePath)).includes('-stage-')) {
      const replacementOperationPath = String(filePath);
      replacementPath = path.join(workbenchDirectory, path.basename(replacementOperationPath));
      const injectedPath = `${replacementOperationPath}.external`;
      await fs.writeFile(injectedPath, foreignContent, 'utf8');
      await originalRename(injectedPath, replacementOperationPath);
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
  expect((await fs.lstat(buildIslandPatchPaths(appRoot).transactionJournalPath)).isFile()).toBe(
    true
  );
});

test('restore reports a physical mutation performed by successful transaction recovery', async () => {
  const appRoot = await createAppRoot('recovery-mutation-result');
  await restoreIslandShell({ appRoot, registryHome });
  const paths = buildIslandPatchPaths(appRoot);
  const id = crypto.randomUUID();
  const transactionContent = '{"pending":true}\n';
  const backupPath = transactionTemporaryPath(paths.manifestPath, id, 'backup');
  await fs.writeFile(paths.manifestPath, transactionContent, 'utf8');
  await fs.writeFile(
    paths.transactionJournalPath,
    JSON.stringify(
      {
        version: 3,
        id,
        appRoot,
        phase: 'committing',
        entries: [
          {
            filePath: paths.manifestPath,
            backupPath,
            existed: false,
            originalChecksum: null,
            desiredChecksum: sha256Base64(transactionContent),
          },
        ],
      },
      null,
      2
    ).concat('\n'),
    'utf8'
  );

  await expect(restoreIslandShell({ appRoot, registryHome })).resolves.toMatchObject({
    changed: true,
    desiredStateChanged: false,
    registryChanged: false,
    physicalChanged: true,
  });
  await expect(fs.stat(paths.manifestPath)).rejects.toThrow();
  await expect(fs.stat(paths.transactionJournalPath)).rejects.toThrow();
});

test('post-rollback cleanup failure retains the completed physical mutation fact', async () => {
  const appRoot = await createAppRoot('rollback-cleanup-mutation-fact');
  await restoreIslandShell({ appRoot, registryHome });
  const paths = buildIslandPatchPaths(appRoot);
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const desiredHtml = `${originalHtml}\n<!-- pending transaction -->\n`;
  const id = crypto.randomUUID();
  const backupPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'backup');
  const stagedPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'stage');
  await fs.writeFile(backupPath, originalHtml, 'utf8');
  await fs.mkdir(stagedPath);
  await fs.writeFile(
    path.join(stagedPath, 'cleanup-blocker'),
    'preserve failure evidence\n',
    'utf8'
  );
  await fs.writeFile(paths.workbenchHtmlPath, desiredHtml, 'utf8');
  await fs.writeFile(
    paths.transactionJournalPath,
    JSON.stringify({
      version: 3,
      id,
      appRoot,
      phase: 'committing',
      entries: [
        {
          filePath: paths.workbenchHtmlPath,
          backupPath,
          stagedPath,
          existed: true,
          originalChecksum: sha256Base64(originalHtml),
          desiredChecksum: sha256Base64(desiredHtml),
        },
      ],
    }).concat('\n'),
    'utf8'
  );

  await expect(restoreIslandShell({ appRoot, registryHome })).rejects.toMatchObject({
    changed: true,
    physicalChanged: true,
    incompleteRecovery: true,
  });
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(originalHtml);
  expect((await fs.stat(stagedPath)).isDirectory()).toBe(true);
  expect((await fs.stat(paths.transactionJournalPath)).isFile()).toBe(true);
});

test('transaction recovery rejects a journal target outside the owned patch set', async () => {
  const appRoot = await createAppRoot('unowned-journal-target');
  const paths = buildIslandPatchPaths(appRoot);
  const outsideTarget = path.join(testRoot, 'outside-target.txt');
  const outsideContent = 'outside generation\n';
  const id = crypto.randomUUID();
  await fs.writeFile(outsideTarget, outsideContent, 'utf8');
  await fs.writeFile(
    paths.transactionJournalPath,
    JSON.stringify({
      version: 3,
      id,
      appRoot,
      phase: 'committing',
      entries: [
        {
          filePath: outsideTarget,
          backupPath: transactionTemporaryPath(outsideTarget, id, 'backup'),
          stagedPath: transactionTemporaryPath(outsideTarget, id, 'stage'),
          existed: true,
          originalChecksum: sha256Base64(outsideContent),
          desiredChecksum: sha256Base64('replacement generation\n'),
        },
      ],
    }).concat('\n'),
    'utf8'
  );

  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'transaction-blocked',
    transaction: { kind: 'corrupt', recoverability: 'manual' },
  });
  await expect(restoreIslandShell({ appRoot, registryHome })).rejects.toThrow(
    'transaction journal contains an invalid entry'
  );
  expect(await fs.readFile(outsideTarget, 'utf8')).toBe(outsideContent);
});

test('raw CLI failure envelopes preserve all actionable recovery causes', async () => {
  const appRoot = await createAppRoot('aggregate-cli-recovery');
  await restoreIslandShell({ appRoot, registryHome });
  const paths = buildIslandPatchPaths(appRoot);
  const originalHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const originalProduct = await fs.readFile(paths.productJsonPath, 'utf8');
  const desiredHtml = `${originalHtml}\n<!-- desired generation -->\n`;
  const desiredProduct = `${originalProduct}\n`;
  const externalHtml = `${originalHtml}\n<!-- external generation -->\n`;
  const externalProduct = `${originalProduct} `;
  const id = crypto.randomUUID();
  const htmlBackup = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'backup');
  const htmlStage = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'stage');
  const productBackup = transactionTemporaryPath(paths.productJsonPath, id, 'backup');
  const productStage = transactionTemporaryPath(paths.productJsonPath, id, 'stage');
  await Promise.all([
    fs.writeFile(htmlBackup, originalHtml, 'utf8'),
    fs.writeFile(htmlStage, desiredHtml, 'utf8'),
    fs.writeFile(productBackup, originalProduct, 'utf8'),
    fs.writeFile(productStage, desiredProduct, 'utf8'),
    fs.writeFile(paths.workbenchHtmlPath, externalHtml, 'utf8'),
    fs.writeFile(paths.productJsonPath, externalProduct, 'utf8'),
  ]);
  await fs.writeFile(
    paths.transactionJournalPath,
    JSON.stringify({
      version: 3,
      id,
      appRoot,
      phase: 'committing',
      entries: [
        {
          filePath: paths.workbenchHtmlPath,
          backupPath: htmlBackup,
          stagedPath: htmlStage,
          existed: true,
          originalChecksum: sha256Base64(originalHtml),
          desiredChecksum: sha256Base64(desiredHtml),
        },
        {
          filePath: paths.productJsonPath,
          backupPath: productBackup,
          stagedPath: productStage,
          existed: true,
          originalChecksum: sha256Base64(originalProduct),
          desiredChecksum: sha256Base64(desiredProduct),
        },
      ],
    }).concat('\n'),
    'utf8'
  );

  const child = Bun.spawn(
    [
      process.execPath,
      path.resolve('apps/vscode/src/islandCli.ts'),
      'restore',
      '--app-root',
      appRoot,
    ],
    {
      env: { ...process.env, HOME: registryHome },
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
  const failure = JSON.parse(stderr);

  expect(exitCode).toBe(1);
  expect(stdout).toBe('');
  expect(failure).toMatchObject({
    changed: false,
    physicalChanged: false,
    externalDrift: true,
    incompleteRecovery: true,
  });
  expect(failure.causes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringContaining(paths.workbenchHtmlPath) }),
      expect.objectContaining({ reason: expect.stringContaining(paths.productJsonPath) }),
    ])
  );
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(externalHtml);
  expect(await fs.readFile(paths.productJsonPath, 'utf8')).toBe(externalProduct);
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

test('verified v3 cleanup failure is visible and remains retryable from the journal', async () => {
  const appRoot = await createAppRoot('verified-cleanup-retry');
  const paths = buildIslandPatchPaths(appRoot);
  const id = crypto.randomUUID();
  const backupPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'backup');
  await fs.mkdir(backupPath);
  await fs.writeFile(
    paths.transactionJournalPath,
    JSON.stringify(
      {
        version: 3,
        id,
        appRoot,
        phase: 'verified',
        entries: [
          {
            filePath: paths.workbenchHtmlPath,
            backupPath,
            existed: false,
            originalChecksum: null,
            desiredChecksum: null,
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
    transaction: { kind: 'recoverable', phase: 'verified' },
  });
  expect((await fs.stat(paths.transactionJournalPath)).isFile()).toBe(true);

  await fs.rm(backupPath, { recursive: true });
  await expect(readIslandShellStatus({ appRoot, registryHome })).resolves.toMatchObject({
    classification: 'transaction-pending',
    transaction: { kind: 'recoverable', phase: 'verified' },
  });
  expect((await fs.stat(paths.transactionJournalPath)).isFile()).toBe(true);
  await restoreIslandShell({ appRoot, registryHome });
  await expect(fs.stat(paths.transactionJournalPath)).rejects.toThrow();
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function expectRestoredAppRoot(appRoot: string): Promise<void> {
  const { productJsonPath, workbenchHtmlPath } = buildIslandPatchPaths(appRoot);
  const html = await fs.readFile(workbenchHtmlPath, 'utf8');
  const product = await fs.readFile(productJsonPath, 'utf8');

  expect(html).not.toContain(TYRIAN_MARKER_START);
  expect(JSON.parse(product).checksums[WORKBENCH_CHECKSUM_KEY]).toBe(sha256Base64(html));
  await expectOnlyWorkbenchHtmlSidecarRemains(appRoot);
}

async function writeLegacyManagedRootsRegistry(appRoots: string[]): Promise<string> {
  const registryPath = buildLegacyManagedRootsRegistryPath(registryHome);

  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    JSON.stringify({ version: 1, appRoots }, null, 2).concat('\n'),
    'utf8'
  );

  return registryPath;
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

async function writeLegacyManagedRootsRegistryContent(content: string): Promise<void> {
  const registryPath = buildLegacyManagedRootsRegistryPath(registryHome);

  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, content, 'utf8');
}

async function writeManagedRootRecord(appRoot: string): Promise<string> {
  const recordPath = buildManagedRootRecordPath(appRoot, registryHome);

  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(
    recordPath,
    JSON.stringify({ version: 1, appRoot }, null, 2).concat('\n'),
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

function transactionTemporaryPath(
  filePath: string,
  transactionId: string,
  kind: 'backup' | 'stage' | 'retired'
): string {
  return path.join(
    path.dirname(filePath),
    `.tyrian-night-${transactionId}-${kind}-${path.basename(filePath)}.tmp`
  );
}
