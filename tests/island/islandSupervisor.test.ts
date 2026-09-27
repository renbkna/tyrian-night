import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { applyIslandShell } from '../../apps/vscode/src/islandShell.js';
import {
  describeIslandShellFailure,
  IslandPartialMutationError,
} from '../../apps/vscode/src/islandShellContract.js';
import { readIslandMutationFacts } from '../../apps/vscode/src/islandMutationFacts.js';
import { publishManagedRootRecord } from '../../apps/vscode/src/islandRegistry.js';
import {
  applyIslandUiSupervised,
  convergeIslandUiSupervised,
  readIslandUiSupervisorStatuses,
  restoreIslandUiSupervised,
  superviseIslandUiStatus,
} from '../../apps/vscode/src/islandSupervisor.js';
import {
  WORKBENCH_CHECKSUM_KEY,
  WORKBENCH_CSS_LINK,
  buildIslandPatchPaths,
  buildManagedRootRecordPath,
  buildManagedRootsDirectoryPath,
} from '../../apps/vscode/src/islandPatchContract.js';

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

test('already-disabled restore changes physical state without rewriting desired state', async () => {
  const appRoot = await createAppRoot('restore-rollback-partial');
  const cssSource = await writeCssSource('restore-rollback.css');
  await applyIslandShell({ appRoot, cssSourcePath: cssSource, themeVersion: 'test', registryHome });
  await fs.writeFile(
    buildManagedRootRecordPath(appRoot, registryHome),
    JSON.stringify({ appRoot, desiredCssFile: null }).concat('\n'),
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

test('typed partial failures preserve supervisor changed classification', () => {
  const partialFailure = new IslandPartialMutationError(
    'apply stopped',
    { physicalChanged: true },
    { cause: new Error('write failed') }
  );

  expect(readIslandMutationFacts(partialFailure).changed).toBe(true);
  expect(readIslandMutationFacts(new Error('unchanged failure')).changed).toBe(false);
  expect(
    readIslandMutationFacts(
      new AggregateError([Object.assign(new Error('nested mutation'), { physicalChanged: true })])
    ).changed
  ).toBe(true);
});

test('public failure normalization preserves both actionable aggregate causes', () => {
  const message = 'Tyrian changed Island files before the operation failed.';
  const failure = new IslandPartialMutationError(
    message,
    { physicalChanged: true, incompleteRecovery: true },
    {
      cause: new AggregateError(
        [
          new Error('rename failed at workbench.html'),
          new Error('verification failed at workbench.backup.html'),
        ],
        message
      ),
    }
  );

  expect(describeIslandShellFailure(failure)).toMatchObject({
    physicalChanged: true,
    incompleteRecovery: true,
    causes: expect.arrayContaining([
      { code: 'blocked', reason: 'rename failed at workbench.html' },
      { code: 'blocked', reason: 'verification failed at workbench.backup.html' },
    ]),
  });
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

test('missing registered roots receive a typed prune recommendation before permission advice', async () => {
  const appRoot = path.join(testRoot, 'missing-recommendation');
  const recordPath = buildManagedRootRecordPath(appRoot, registryHome);
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(
    recordPath,
    JSON.stringify({ appRoot, desiredCssFile: null }, null, 2).concat('\n'),
    'utf8'
  );

  await expect(readIslandUiSupervisorStatuses({ registryHome })).resolves.toMatchObject({
    statuses: [
      {
        appRoot,
        classification: 'missing',
        recommendedAction: 'prune-missing',
        accessInspection: {
          kind: 'available',
          writeAccess: { writable: false },
        },
      },
    ],
  });
});

test('corrupt registration records recommend Classic UI restore', async () => {
  const appRoot = await createAppRoot('corrupt-registration-remedy');
  const recordPath = buildManagedRootRecordPath(appRoot, registryHome);
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, JSON.stringify({ appRoot }, null, 2).concat('\n'), 'utf8');

  await expect(
    readIslandUiSupervisorStatuses({ preferredAppRoots: [appRoot], registryHome })
  ).resolves.toMatchObject({
    statuses: [
      {
        appRoot,
        registrationState: 'corrupt',
        registered: true,
        classification: 'broken-backup',
        recommendedAction: 'restore',
      },
    ],
  });
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
          accessInspection: {
            kind: 'available',
            writeAccess: { writable: false },
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

    expect(inventory.statuses[0]?.accessInspection).toMatchObject({
      kind: 'available',
      writeAccess: {
        writable: true,
        blockedPaths: [],
      },
    });
  } finally {
    await fs.chmod(workbenchHtmlPath, 0o644);
    await fs.chmod(productJsonPath, 0o644);
  }
});

test('failed write-access inspection is explicit and forces manual recovery', async () => {
  const appRoot = await createAppRoot('failed-access-inspection');
  const inventory = await readIslandUiSupervisorStatuses({
    preferredAppRoots: [appRoot],
    registryHome,
  });
  const status = inventory.statuses[0]!;

  expect(
    superviseIslandUiStatus(status, {
      kind: 'failed',
      reason: 'app root changed generation during access inspection',
    })
  ).toMatchObject({
    accessInspection: {
      kind: 'failed',
      reason: 'app root changed generation during access inspection',
    },
    recommendedAction: 'manual-recovery',
  });
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
    await fs.writeFile(corruptPaths.productJsonPath, '{}\n', 'utf8');

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
          code: 'unsupported',
          reason: expect.stringContaining('Missing checksums object'),
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
    JSON.stringify({ appRoot, desiredCssFile: null }, null, 2).concat('\n'),
    'utf8'
  );

  try {
    await fs.chmod(registryDirectory, 0o555);
    await expect(restoreIslandUiSupervised({ registryHome })).resolves.toMatchObject({
      kind: 'permission-required',
      changed: false,
      registryChanged: false,
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

test('converge applies the desired style instead of the repair fallback', async () => {
  const appRoot = await createAppRoot('converge-desired');
  const islandDirectory = await writeIslandDirectory();
  await applyIslandShell({
    appRoot,
    cssSourcePath: path.join(islandDirectory, 'tyrian-nocturne.css'),
    themeVersion: 'test',
    registryHome,
  });

  const convergence = await convergeIslandUiSupervised({
    appRoot,
    islandDirectory,
    themeVersion: 'test',
    intent: { kind: 'repair', fallbackCssFile: 'tyrian-night.css' },
    registryHome,
  });

  expect(convergence).toMatchObject({
    action: 'apply',
    result: { kind: 'already-current', status: { desiredCssFile: 'tyrian-nocturne.css' } },
  });
});

test('startup converge restores leftover Island files; repair without a style keeps them', async () => {
  const appRoot = await createAppRoot('converge-disabled');
  const islandDirectory = await writeIslandDirectory();
  await applyIslandShell({
    appRoot,
    cssSourcePath: path.join(islandDirectory, 'tyrian-night.css'),
    themeVersion: 'test',
    registryHome,
  });
  await publishManagedRootRecord(appRoot, null, { registryHome });
  const options = { appRoot, islandDirectory, themeVersion: 'test', registryHome };

  await expect(
    convergeIslandUiSupervised({
      ...options,
      intent: { kind: 'repair', fallbackCssFile: undefined },
    })
  ).resolves.toEqual({ action: 'none' });
  await expect(
    convergeIslandUiSupervised({ ...options, intent: { kind: 'startup' } })
  ).resolves.toMatchObject({
    action: 'restore',
    result: { physicalChanged: true, status: { classification: 'clean' } },
  });
});

test('converge rejects an unavailable desired style before changing app files', async () => {
  const appRoot = await createAppRoot('converge-unavailable');
  const islandDirectory = await writeIslandDirectory();
  await publishManagedRootRecord(appRoot, 'retired-style.css', { registryHome });
  const { workbenchHtmlPath } = buildIslandPatchPaths(appRoot);
  const before = await fs.readFile(workbenchHtmlPath, 'utf8');

  await expect(
    convergeIslandUiSupervised({
      appRoot,
      islandDirectory,
      themeVersion: 'test',
      intent: { kind: 'repair', fallbackCssFile: 'tyrian-night.css' },
      registryHome,
    })
  ).rejects.toMatchObject({
    code: 'unsupported',
    message: expect.stringContaining("unavailable style 'retired-style.css'"),
  });
  expect(await fs.readFile(workbenchHtmlPath, 'utf8')).toBe(before);
});

test('converge refuses a corrupt desired-state record', async () => {
  const appRoot = await createAppRoot('converge-corrupt');
  const islandDirectory = await writeIslandDirectory();
  const recordPath = buildManagedRootRecordPath(appRoot, registryHome);
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, '{"appRoot":42}\n', 'utf8');

  await expect(
    convergeIslandUiSupervised({
      appRoot,
      islandDirectory,
      themeVersion: 'test',
      intent: { kind: 'startup' },
      registryHome,
    })
  ).rejects.toMatchObject({ code: 'corrupt' });
});

async function writeIslandDirectory(): Promise<string> {
  const islandDirectory = path.join(testRoot, 'island');
  await fs.mkdir(islandDirectory, { recursive: true });
  for (const name of ['tyrian-night.css', 'tyrian-nocturne.css']) {
    await fs.writeFile(
      path.join(islandDirectory, name),
      `.monaco-workbench { color: ${name}; }\n`,
      'utf8'
    );
  }
  return islandDirectory;
}

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

function sha256Base64(content: string): string {
  return crypto.hash('sha256', content, 'base64').replace(/=+$/, '');
}
