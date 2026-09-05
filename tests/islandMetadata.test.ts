import { afterEach, beforeEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  buildIslandPatchPaths,
  buildManagedRootRecordPath,
  WORKBENCH_CHECKSUM_KEY,
  WORKBENCH_CSS_LINK,
} from '../apps/vscode/src/islandPatchContract';
import {
  applyIslandShell,
  readAllIslandShellStatuses,
  readIslandShellStatus,
  restoreIslandShell,
} from '../apps/vscode/src/islandShell';
import { applyIslandUiSupervised } from '../apps/vscode/src/islandSupervisor';

let registryHome: string;
let testRoot: string;

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-island-metadata-'));
  registryHome = path.join(testRoot, 'home');
  await fs.mkdir(registryHome, { recursive: true });
});

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
});

test('SIGKILL after journal retirement remains Doctor-recoverable and supervised apply settles it', async () => {
  const fixture = await createAppliedRoot('journal-retirement');
  const nextCssPath = await writeCssSource('journal-next.css', 'deepskyblue');
  const journal = durableMetadataPaths(fixture.paths.transactionJournalPath);

  await killIslandOperationAfterMetadataTransition(
    {
      kind: 'apply',
      options: {
        appRoot: fixture.appRoot,
        cssSourcePath: nextCssPath,
        themeVersion: 'next',
        registryHome,
      },
    },
    journal,
    'rename'
  );

  expect(await pathExists(journal.canonicalPath)).toBe(false);
  expect(await pathExists(journal.retiredPath)).toBe(true);
  expect(await pathExists(journal.candidatePath)).toBe(true);
  expect(JSON.parse(await fs.readFile(journal.retiredPath, 'utf8'))).toMatchObject({
    phase: 'preparing',
  });

  await expect(
    readIslandShellStatus({ appRoot: fixture.appRoot, registryHome })
  ).resolves.toMatchObject({
    classification: 'transaction-pending',
    transaction: { kind: 'recoverable', recoverability: 'automatic' },
  });

  const recovered = await applyIslandUiSupervised({
    appRoot: fixture.appRoot,
    cssSourcePath: nextCssPath,
    themeVersion: 'next',
    registryHome,
  });

  expect(['applied', 'already-current']).toContain(recovered.kind);
  expect(recovered.status).toMatchObject({
    classification: 'patched',
    desiredThemeId: path.basename(nextCssPath),
    transaction: { kind: 'clean' },
  });
  await expectPathsAbsent(journal.retiredPath, journal.candidatePath);
});

test('SIGKILL after registry retirement remains status-all discoverable and later apply settles it', async () => {
  const fixture = await createAppliedRoot('registry-retirement');
  const nextCssPath = await writeCssSource('registry-next.css', 'mediumorchid');
  const record = durableMetadataPaths(buildManagedRootRecordPath(fixture.appRoot, registryHome));

  await killIslandOperationAfterMetadataTransition(
    {
      kind: 'apply',
      options: {
        appRoot: fixture.appRoot,
        cssSourcePath: nextCssPath,
        themeVersion: 'next',
        registryHome,
      },
    },
    record,
    'rename'
  );

  expect(await pathExists(record.canonicalPath)).toBe(false);
  expect(await pathExists(record.retiredPath)).toBe(true);
  expect(await pathExists(record.candidatePath)).toBe(true);
  expect(JSON.parse(await fs.readFile(record.retiredPath, 'utf8'))).toMatchObject({
    appRoot: fixture.appRoot,
    desiredThemeId: path.basename(fixture.cssSourcePath),
  });

  const discovered = await readAllIslandShellStatuses({ registryHome });
  expect(discovered).toHaveLength(1);
  expect(discovered[0]).toMatchObject({
    appRoot: fixture.appRoot,
    registrationState: 'valid',
    desiredThemeId: path.basename(fixture.cssSourcePath),
  });

  const completed = await applyIslandShell({
    appRoot: fixture.appRoot,
    cssSourcePath: nextCssPath,
    themeVersion: 'next',
    registryHome,
  });

  expect(completed.status).toMatchObject({
    classification: 'patched',
    desiredThemeId: path.basename(nextCssPath),
    transaction: { kind: 'clean' },
  });
  await expectPathsAbsent(record.retiredPath, record.candidatePath);
});

test.each([
  'distinct',
  'aliased',
] as const)('SIGKILL after journal reification settles with candidate %s', async (candidateKind) => {
  const fixture = await createAppliedRoot('journal-reification');
  const nextCssPath = await writeCssSource('reification-next.css', 'tomato');
  const journal = durableMetadataPaths(fixture.paths.transactionJournalPath);

  await killIslandOperationAfterMetadataTransition(
    {
      kind: 'apply',
      options: {
        appRoot: fixture.appRoot,
        cssSourcePath: nextCssPath,
        themeVersion: 'next',
        registryHome,
      },
    },
    journal,
    'rename'
  );
  if (candidateKind === 'aliased') {
    await fs.unlink(journal.candidatePath);
    await fs.link(journal.retiredPath, journal.candidatePath);
  }
  await killIslandOperationAfterMetadataTransition(
    { kind: 'restore', options: { appRoot: fixture.appRoot, registryHome } },
    journal,
    'link'
  );

  const [canonical, retired, candidate] = await Promise.all([
    fs.stat(journal.canonicalPath),
    fs.stat(journal.retiredPath),
    fs.stat(journal.candidatePath),
  ]);
  expect({ device: String(canonical.dev), inode: String(canonical.ino) }).toEqual({
    device: String(retired.dev),
    inode: String(retired.ino),
  });
  expect(candidate.dev === canonical.dev && candidate.ino === canonical.ino).toBe(
    candidateKind === 'aliased'
  );
  expect(JSON.parse(await fs.readFile(journal.canonicalPath, 'utf8'))).toMatchObject({
    phase: 'preparing',
  });
  expect(JSON.parse(await fs.readFile(journal.candidatePath, 'utf8'))).toMatchObject({
    phase: candidateKind === 'aliased' ? 'preparing' : 'prepared',
  });

  const restored = await restoreIslandShell({ appRoot: fixture.appRoot, registryHome });

  expect(restored.status).toMatchObject({
    classification: 'clean',
    transaction: { kind: 'clean' },
  });
  await expectPathsAbsent(journal.canonicalPath, journal.retiredPath, journal.candidatePath);
});

test('divergent canonical and predecessor journals without a candidate block supervised mutation and preserve manual evidence', async () => {
  const fixture = await createAppliedRoot('divergent-journal-generations');
  const interruptedCssPath = await writeCssSource('divergent-interrupted.css', 'orchid');
  const blockedCssPath = await writeCssSource('divergent-blocked.css', 'goldenrod');
  const journal = durableMetadataPaths(fixture.paths.transactionJournalPath);

  await killIslandOperationAfterMetadataTransition(
    {
      kind: 'apply',
      options: {
        appRoot: fixture.appRoot,
        cssSourcePath: interruptedCssPath,
        themeVersion: 'interrupted',
        registryHome,
      },
    },
    journal,
    'rename'
  );

  const predecessor = await readExactFileGeneration(journal.retiredPath);
  const candidate = await readExactFileGeneration(journal.candidatePath);
  await expectPathsAbsent(journal.canonicalPath);
  expect(candidate.bytes).not.toBe(predecessor.bytes);
  expect({ device: candidate.device, inode: candidate.inode }).not.toEqual({
    device: predecessor.device,
    inode: predecessor.inode,
  });

  // The candidate proves the canonical publication while the predecessor differs.
  await fs.link(journal.candidatePath, journal.canonicalPath);
  await expect(
    readIslandShellStatus({ appRoot: fixture.appRoot, registryHome })
  ).resolves.toMatchObject({
    transaction: { kind: 'recoverable', recoverability: 'automatic' },
  });
  // Removing that proof leaves two distinct generations requiring manual recovery.
  await fs.unlink(journal.candidatePath);
  await expectPathsAbsent(journal.candidatePath);
  const canonical = await readExactFileGeneration(journal.canonicalPath);
  expect(canonical).toEqual(candidate);
  expect(canonical.bytes).not.toBe(predecessor.bytes);

  await expect(
    readIslandShellStatus({ appRoot: fixture.appRoot, registryHome })
  ).resolves.toMatchObject({
    classification: 'transaction-blocked',
    transaction: {
      kind: 'corrupt',
      recoverability: 'manual',
      reason: expect.stringContaining('ambiguous canonical and retired generations'),
    },
  });

  await expect(
    applyIslandUiSupervised({
      appRoot: fixture.appRoot,
      cssSourcePath: blockedCssPath,
      themeVersion: 'blocked',
      registryHome,
    })
  ).resolves.toMatchObject({
    kind: 'blocked',
    changed: false,
    desiredStateChanged: false,
    registryChanged: false,
    physicalChanged: false,
    externalDrift: false,
    incompleteRecovery: true,
    reason: expect.stringContaining('ambiguous canonical and retired generations'),
  });

  await expectExactFileGeneration(journal.canonicalPath, canonical);
  await expectExactFileGeneration(journal.retiredPath, predecessor);
  await expectPathsAbsent(journal.candidatePath);
});

type IslandChildOperation =
  | {
      kind: 'apply';
      options: {
        appRoot: string;
        cssSourcePath: string;
        themeVersion: string;
        registryHome: string;
      };
    }
  | { kind: 'restore'; options: { appRoot: string; registryHome: string } };

type DurableMetadataPaths = {
  canonicalPath: string;
  retiredPath: string;
  candidatePath: string;
};

type ExactFileGeneration = {
  bytes: string;
  device: string;
  inode: string;
};

function durableMetadataPaths(canonicalPath: string): DurableMetadataPaths {
  const directoryPath = path.dirname(canonicalPath);
  const baseName = path.basename(canonicalPath);
  return {
    canonicalPath,
    retiredPath: path.join(directoryPath, `.tyrian-night-retired-${baseName}.tmp`),
    candidatePath: path.join(directoryPath, `.tyrian-night-candidate-${baseName}.tmp`),
  };
}

async function createAppliedRoot(name: string): Promise<{
  appRoot: string;
  cssSourcePath: string;
  paths: ReturnType<typeof buildIslandPatchPaths>;
}> {
  const appRoot = path.join(testRoot, name);
  const paths = buildIslandPatchPaths(appRoot);
  const html = `<html>\n\t<head>\n\t\t${WORKBENCH_CSS_LINK}\n\t</head>\n</html>\n`;
  await fs.mkdir(paths.workbenchDirPath, { recursive: true });
  await fs.writeFile(paths.workbenchHtmlPath, html, 'utf8');
  await fs.writeFile(
    paths.productJsonPath,
    JSON.stringify(
      {
        checksums: {
          [WORKBENCH_CHECKSUM_KEY]: crypto.hash('sha256', html, 'base64').replace(/=+$/u, ''),
        },
      },
      null,
      '\t'
    ).concat('\n'),
    'utf8'
  );
  const cssSourcePath = await writeCssSource(`${name}-first.css`, 'steelblue');
  await applyIslandShell({ appRoot, cssSourcePath, themeVersion: 'first', registryHome });
  return { appRoot, cssSourcePath, paths };
}

async function writeCssSource(name: string, color: string): Promise<string> {
  const cssSourcePath = path.join(testRoot, name);
  await fs.writeFile(cssSourcePath, `.monaco-workbench { color: ${color}; }\n`, 'utf8');
  return cssSourcePath;
}

async function killIslandOperationAfterMetadataTransition(
  operation: IslandChildOperation,
  metadata: DurableMetadataPaths,
  transition: 'rename' | 'link'
): Promise<void> {
  const readyPath = path.join(testRoot, `metadata-${transition}-${crypto.randomUUID()}.ready`);
  const preloadPath = await writeMetadataKillPreload(transition, metadata, readyPath);
  const method = operation.kind === 'apply' ? 'applyIslandShell' : 'restoreIslandShell';
  const islandShellPath = path.resolve('apps/vscode/src/islandShell.ts');
  const program = [
    `const island = await import(${JSON.stringify(islandShellPath)});`,
    `await island.${method}(${JSON.stringify(operation.options)});`,
  ].join(' ');
  const child = Bun.spawn([process.execPath, '--preload', preloadPath, '-e', program], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const evidence = JSON.parse(await waitForFile(readyPath)) as {
    source: string;
    destination: string;
  };
  const exitCode = await Promise.race([
    child.exited,
    delay(2_000).then(() => {
      throw new Error(`Timed out waiting for metadata crash child at '${metadata.canonicalPath}'.`);
    }),
  ]);

  expect(exitCode).not.toBe(0);
  expect(evidence).toEqual({
    source:
      transition === 'rename'
        ? path.basename(metadata.canonicalPath)
        : path.basename(metadata.retiredPath),
    destination:
      transition === 'rename'
        ? path.basename(metadata.retiredPath)
        : path.basename(metadata.canonicalPath),
  });
}

async function writeMetadataKillPreload(
  transition: 'rename' | 'link',
  metadata: DurableMetadataPaths,
  readyPath: string
): Promise<string> {
  const preloadPath = path.join(testRoot, `kill-metadata-${transition}-${crypto.randomUUID()}.mjs`);
  const sourceBaseName =
    transition === 'rename'
      ? path.basename(metadata.canonicalPath)
      : path.basename(metadata.retiredPath);
  const destinationBaseName =
    transition === 'rename'
      ? path.basename(metadata.retiredPath)
      : path.basename(metadata.canonicalPath);
  await fs.writeFile(
    preloadPath,
    [
      "import fs from 'node:fs/promises';",
      "import path from 'node:path';",
      `const sourceBaseName = ${JSON.stringify(sourceBaseName)};`,
      `const destinationBaseName = ${JSON.stringify(destinationBaseName)};`,
      `const readyPath = ${JSON.stringify(readyPath)};`,
      `const original = fs.${transition}.bind(fs);`,
      `fs.${transition} = async (source, destination, ...rest) => {`,
      '  const result = await original(source, destination, ...rest);',
      '  if (',
      '    path.basename(String(source)) === sourceBaseName &&',
      '    path.basename(String(destination)) === destinationBaseName',
      '  ) {',
      "    await fs.writeFile(readyPath.concat('.next'), JSON.stringify({ source: path.basename(String(source)), destination: path.basename(String(destination)) }), 'utf8');",
      "    await fs.rename(readyPath.concat('.next'), readyPath);",
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

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      if (content.length > 0) return content;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for metadata crash evidence at '${filePath}'.`);
}

async function readExactFileGeneration(filePath: string): Promise<ExactFileGeneration> {
  const [content, stats] = await Promise.all([fs.readFile(filePath), fs.lstat(filePath)]);
  expect(stats.isFile()).toBe(true);
  expect(stats.isSymbolicLink()).toBe(false);
  return {
    bytes: content.toString('hex'),
    device: String(stats.dev),
    inode: String(stats.ino),
  };
}

async function expectExactFileGeneration(
  filePath: string,
  expected: ExactFileGeneration
): Promise<void> {
  expect(await readExactFileGeneration(filePath)).toEqual(expected);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function expectPathsAbsent(...filePaths: string[]): Promise<void> {
  for (const filePath of filePaths) {
    expect(await pathExists(filePath)).toBe(false);
  }
}
