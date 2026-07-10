import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { applyIslandShell } from '../apps/vscode/src/islandShell';
import {
  IslandFileTransactionPartialMutationError,
  rollbackFailedFileTransactionCore,
} from '../apps/vscode/src/islandFileTransactionCore';
import { IslandRegistryQuarantineError } from '../apps/vscode/src/islandRegistryMutationCore';
import { didIslandMutationChange } from '../apps/vscode/src/islandSupervisorCore';
import {
  applyIslandUiSupervised,
  readIslandUiSupervisorStatuses,
  restoreIslandUiSupervised,
} from '../apps/vscode/src/islandSupervisor';
import {
  WORKBENCH_CHECKSUM_KEY,
  WORKBENCH_CSS_LINK,
  buildIslandPatchPaths,
  buildManagedRootRecordPath,
  buildManagedRootsDirectoryPath,
} from '../apps/vscode/src/islandPatchContract';

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

test('supervised apply recovers a committing journal before deciding it is current', async () => {
  const appRoot = await createAppRoot('recover-before-noop');
  const cssSource = await writeCssSource('recover-before-noop.css');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  const paths = buildIslandPatchPaths(appRoot);
  const desiredHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const originalHtml = cleanWorkbenchHtml();
  const id = crypto.randomUUID();
  const backupPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'backup');
  const stagedPath = transactionTemporaryPath(paths.workbenchHtmlPath, id, 'stage');
  await fs.writeFile(backupPath, originalHtml, 'utf8');
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

  await expect(
    applyIslandUiSupervised({
      appRoot,
      cssSourcePath: cssSource,
      themeVersion: 'test',
      registryHome,
    })
  ).resolves.toMatchObject({ kind: 'applied', changed: true });
  expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).toBe(desiredHtml);
  await expect(fs.stat(paths.transactionJournalPath)).rejects.toThrow();
  await expect(fs.stat(backupPath)).rejects.toThrow();
});

test('supervised apply reports publish-first physical failure as changed', async () => {
  const appRoot = await createAppRoot('partial-apply');
  const cssSource = await writeCssSource('partial-apply.css');
  const backupPath = buildIslandPatchPaths(appRoot).backupHtmlPath;
  await fs.symlink(cssSource, backupPath);

  await expect(
    applyIslandUiSupervised({
      appRoot,
      cssSourcePath: cssSource,
      themeVersion: 'test',
      registryHome,
    })
  ).resolves.toMatchObject({
    kind: 'blocked',
    changed: true,
    reason: expect.stringContaining('symbolic link'),
  });
});

test('repair changes physical state while desired state is unchanged', async () => {
  const appRoot = await createAppRoot('repair-rollback-partial');
  const cssSource = await writeCssSource('repair-rollback.css');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  const { islandCssPath } = buildIslandPatchPaths(appRoot);
  await fs.writeFile(islandCssPath, '.monaco-workbench { color: corrupted; }\n', 'utf8');

  await expect(
    applyIslandUiSupervised({
      appRoot,
      cssSourcePath: cssSource,
      themeVersion: 'test',
      registryHome,
    })
  ).resolves.toMatchObject({
    kind: 'applied',
    changed: true,
  });
});

test('supervised restore reports publish-first physical failure as changed', async () => {
  const appRoot = await createAppRoot('partial-restore');
  const cssSource = await writeCssSource('partial-restore.css');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  const islandCssPath = buildIslandPatchPaths(appRoot).islandCssPath;
  await fs.rm(islandCssPath);
  await fs.symlink(cssSource, islandCssPath);

  await expect(
    restoreIslandUiSupervised({ preferredAppRoots: [appRoot], registryHome })
  ).resolves.toMatchObject({
    kind: 'blocked',
    changed: true,
    failedAppRoots: [
      { appRoot, code: 'blocked', reason: expect.stringContaining('symbolic link') },
    ],
  });
});

test('already-disabled restore changes physical state without rewriting desired state', async () => {
  const appRoot = await createAppRoot('restore-rollback-partial');
  const cssSource = await writeCssSource('restore-rollback.css');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  await fs.writeFile(
    buildManagedRootRecordPath(appRoot, registryHome),
    JSON.stringify({ version: 2, appRoot, desiredThemeId: null }).concat('\n'),
    'utf8'
  );

  await expect(
    restoreIslandUiSupervised({
      preferredAppRoots: [appRoot],
      registryHome,
    })
  ).resolves.toMatchObject({
    kind: 'restored',
    changed: true,
    failedAppRoots: [],
  });
});

test('typed core partial failures preserve supervisor changed classification', async () => {
  let transactionFailure: unknown;
  try {
    await rollbackFailedFileTransactionCore({
      transactionError: new Error('transaction failed'),
      physicalMutationAttempted: true,
      rollback: async () => {
        throw new Error('rollback failed');
      },
    });
  } catch (error) {
    transactionFailure = error;
  }

  expect(transactionFailure).toBeInstanceOf(IslandFileTransactionPartialMutationError);
  expect(didIslandMutationChange(transactionFailure)).toBe(true);
  expect(
    didIslandMutationChange(
      new IslandRegistryQuarantineError('/quarantine/record.json', new Error('sync failed'))
    )
  ).toBe(true);
  expect(didIslandMutationChange(new Error('unchanged failure'))).toBe(false);
  expect(
    didIslandMutationChange(
      new AggregateError([Object.assign(new Error('nested mutation'), { changed: true })])
    )
  ).toBe(true);
});

test('supervised apply converts a read-only app root into permission-required', async () => {
  const appRoot = await createAppRoot('readonly-apply');
  const cssSource = await writeCssSource('theme.css');
  const {
    productJsonPath: productPath,
    workbenchDirPath: workbenchDir,
    workbenchHtmlPath: workbenchPath,
  } = buildIslandPatchPaths(appRoot);

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
      changed: false,
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

test('supervisor reports physical write access without deciding desired-state policy', async () => {
  const appRoot = await createAppRoot('readonly-status');
  const {
    productJsonPath: productPath,
    workbenchDirPath: workbenchDir,
    workbenchHtmlPath: workbenchPath,
  } = buildIslandPatchPaths(appRoot);

  try {
    await fs.chmod(workbenchDir, 0o555);
    await fs.chmod(workbenchPath, 0o444);
    await fs.chmod(productPath, 0o444);

    await expect(
      readIslandUiSupervisorStatuses({ preferredAppRoots: [appRoot], registryHome })
    ).resolves.toMatchObject({
      statuses: [
        {
          classification: 'clean',
          writeAccess: {
            writable: false,
          },
        },
      ],
      registryDiagnostics: [],
    });
  } finally {
    await fs.chmod(workbenchDir, 0o755);
    await fs.chmod(workbenchPath, 0o644);
    await fs.chmod(productPath, 0o644);
  }
});

test('write access follows atomic replacement directories instead of target write bits', async () => {
  const appRoot = await createAppRoot('readonly-targets-writable-directories');
  const { productJsonPath, workbenchHtmlPath } = buildIslandPatchPaths(appRoot);

  try {
    await fs.chmod(workbenchHtmlPath, 0o444);
    await fs.chmod(productJsonPath, 0o444);

    const inventory = await readIslandUiSupervisorStatuses({
      preferredAppRoots: [appRoot],
      registryHome,
    });

    expect(inventory.statuses[0]?.writeAccess).toMatchObject({
      writable: true,
      blockedPaths: [],
    });
  } finally {
    await fs.chmod(workbenchHtmlPath, 0o644);
    await fs.chmod(productJsonPath, 0o644);
  }
});

test('supervised restore maps write failures to permission-required', async () => {
  const appRoot = await createAppRoot('readonly-restore');
  const cssSource = await writeCssSource('theme.css');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  const {
    productJsonPath: productPath,
    workbenchDirPath: workbenchDir,
    workbenchHtmlPath: workbenchPath,
  } = buildIslandPatchPaths(appRoot);

  try {
    await fs.chmod(workbenchDir, 0o555);
    await fs.chmod(workbenchPath, 0o444);
    await fs.chmod(productPath, 0o444);

    await expect(
      restoreIslandUiSupervised({ preferredAppRoots: [appRoot], registryHome })
    ).resolves.toMatchObject({
      kind: 'permission-required',
      changed: false,
      failedAppRoots: [{ appRoot, code: 'permission-required', reason: expect.any(String) }],
    });
  } finally {
    await fs.chmod(workbenchDir, 0o755);
    await fs.chmod(workbenchPath, 0o644);
    await fs.chmod(productPath, 0o644);
  }
});

test('supervised restore reports quarantined registry records as typed mutations', async () => {
  const appRoot = await createAppRoot('incomplete-registry');
  const cssSource = await writeCssSource('incomplete.css');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  const registryDirectory = buildManagedRootsDirectoryPath(registryHome);
  await fs.writeFile(path.join(registryDirectory, `${'0'.repeat(64)}.json`), '{ broken\n', 'utf8');

  await expect(
    restoreIslandUiSupervised({ preferredAppRoots: [appRoot], registryHome })
  ).resolves.toMatchObject({
    kind: 'restored',
    changed: true,
    failedAppRoots: [],
    quarantinedRecords: [expect.stringContaining('quarantined-managed-app-roots')],
  });
});

test('mixed permission and non-permission restore failures are blocked, not permission-owned', async () => {
  const permissionRoot = await createAppRoot('mixed-permission');
  const corruptRoot = await createAppRoot('mixed-corrupt');
  const cssSource = await writeCssSource('mixed.css');
  await applyIslandShell({
    appRoot: permissionRoot,
    cssSourcePath: cssSource,
    themeVersion: 'test',
    registryHome,
  });
  await applyIslandShell({
    appRoot: corruptRoot,
    cssSourcePath: cssSource,
    themeVersion: 'test',
    registryHome,
  });
  const permissionPaths = buildIslandPatchPaths(permissionRoot);
  const corruptPaths = buildIslandPatchPaths(corruptRoot);

  try {
    await fs.chmod(permissionPaths.workbenchDirPath, 0o555);
    await fs.chmod(permissionPaths.workbenchHtmlPath, 0o444);
    await fs.chmod(permissionPaths.productJsonPath, 0o444);
    await fs.writeFile(corruptPaths.transactionJournalPath, '{ broken journal\n', 'utf8');

    await expect(
      restoreIslandUiSupervised({
        preferredAppRoots: [permissionRoot, corruptRoot],
        registryHome,
      })
    ).resolves.toMatchObject({
      kind: 'blocked',
      changed: false,
      failedAppRoots: expect.arrayContaining([
        {
          appRoot: permissionRoot,
          code: 'permission-required',
          reason: expect.stringMatching(/permission|EACCES|EPERM/i),
        },
        {
          appRoot: corruptRoot,
          code: 'blocked',
          reason: expect.stringContaining('journal is invalid JSON'),
        },
      ]),
    });
  } finally {
    await fs.chmod(permissionPaths.workbenchDirPath, 0o755);
    await fs.chmod(permissionPaths.workbenchHtmlPath, 0o644);
    await fs.chmod(permissionPaths.productJsonPath, 0o644);
  }
});

test('missing-root registry cleanup failures are returned and classified', async () => {
  const appRoot = path.join(testRoot, 'missing-cleanup-permission');
  const registryDirectory = buildManagedRootsDirectoryPath(registryHome);
  const recordPath = buildManagedRootRecordPath(appRoot, registryHome);
  await fs.mkdir(registryDirectory, { recursive: true });
  await fs.writeFile(
    recordPath,
    JSON.stringify({ version: 2, appRoot, desiredThemeId: null }, null, 2).concat('\n'),
    'utf8'
  );

  try {
    await fs.chmod(registryDirectory, 0o555);
    await expect(restoreIslandUiSupervised({ registryHome })).resolves.toMatchObject({
      kind: 'permission-required',
      changed: false,
      failedAppRoots: [
        {
          appRoot,
          code: 'permission-required',
          reason: expect.stringMatching(/permission|EACCES|EPERM/i),
        },
      ],
    });
  } finally {
    await fs.chmod(registryDirectory, 0o755);
  }
});

async function createAppRoot(name: string): Promise<string> {
  const appRoot = path.join(testRoot, name);
  const { productJsonPath, workbenchDirPath, workbenchHtmlPath } = buildIslandPatchPaths(appRoot);
  const html = cleanWorkbenchHtml();

  await fs.mkdir(workbenchDirPath, { recursive: true });
  await fs.writeFile(workbenchHtmlPath, html, 'utf8');
  await fs.writeFile(productJsonPath, productJson(sha256Base64(html)), 'utf8');

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

function transactionTemporaryPath(
  filePath: string,
  transactionId: string,
  kind: 'backup' | 'stage'
): string {
  return path.join(
    path.dirname(filePath),
    `.tyrian-night-${transactionId}-${kind}-${path.basename(filePath)}.tmp`
  );
}

function sha256Base64(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('base64').replace(/=+$/, '');
}
