import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  readIslandInstallationFiles,
  withIslandFileOwner,
  type FileMutation,
  type IslandFileReader,
} from '../apps/vscode/src/islandFileTransaction';
import { buildIslandPatchPaths } from '../apps/vscode/src/islandPatchContract';
import { IslandPartialMutationError } from '../apps/vscode/src/islandShellContract';

let testRoot: string;

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-island-file-owner-'));
});

afterEach(async () => {
  await fs.rm(testRoot, { force: true, recursive: true });
});

test('reader admits only Island patch targets and keeps the journal private', async () => {
  const appRoot = await createAppRoot('reader');
  const paths = buildIslandPatchPaths(appRoot);
  const files = readIslandInstallationFiles(appRoot);

  await files.assertNamespaceCurrent();
  await expect(files.readRequired(paths.workbenchHtmlPath)).resolves.toBe(ORIGINAL_HTML);
  await expect(files.read(paths.transactionJournalPath)).rejects.toThrow('does not admit');
  await expect(files.read(path.join(appRoot, 'unrelated.txt'))).rejects.toThrow('does not admit');
  await expect(fs.readdir(paths.workbenchDirPath)).resolves.toEqual(['workbench.html']);
});

for (const [name, mutationFactory, expectedReason] of [
  [
    'outside target',
    (appRoot: string, _paths: ReturnType<typeof buildIslandPatchPaths>): FileMutation[] => [
      {
        filePath: path.join(appRoot, 'unrelated.txt'),
        content: 'outside\n',
        expectedContent: undefined,
      },
    ],
    'does not admit',
  ],
  [
    'duplicate target',
    (_appRoot: string, paths: ReturnType<typeof buildIslandPatchPaths>): FileMutation[] => [
      {
        filePath: paths.workbenchHtmlPath,
        content: 'first replacement\n',
        expectedContent: ORIGINAL_HTML,
      },
      {
        filePath: paths.workbenchHtmlPath,
        content: 'second replacement\n',
        expectedContent: ORIGINAL_HTML,
      },
    ],
    'duplicate target',
  ],
] as const) {
  test(`commit rejects ${name} before it stages transaction evidence`, async () => {
    const appRoot = await createAppRoot(name.replaceAll(' ', '-'));
    const paths = buildIslandPatchPaths(appRoot);
    const mutations = mutationFactory(appRoot, paths);

    await expect(
      withIslandFileOwner(appRoot, 'v4', async (owner) => {
        await owner.assertRecoverySupported();
        await owner.recover();
        return owner.commit(mutations, async () => undefined);
      })
    ).rejects.toThrow(expectedReason);

    await expect(fs.readFile(paths.workbenchHtmlPath, 'utf8')).resolves.toBe(ORIGINAL_HTML);
    await expect(fs.readFile(paths.productJsonPath, 'utf8')).resolves.toBe(ORIGINAL_PRODUCT);
    await expect(fs.readdir(paths.workbenchDirPath)).resolves.toEqual(['workbench.html']);
    await expect(fs.access(paths.transactionJournalPath)).rejects.toThrow();
  });
}

test('recovery capability and recovery are required before a commit, which snapshots input and rejects concurrent mutation', async () => {
  const appRoot = await createAppRoot('lifecycle');
  const paths = buildIslandPatchPaths(appRoot);
  const mutation: FileMutation = {
    filePath: paths.workbenchHtmlPath,
    content: 'first committed replacement\n',
    expectedContent: ORIGINAL_HTML,
  };

  await withIslandFileOwner(appRoot, 'v4', async (owner) => {
    await expect(owner.commit([mutation], async () => undefined)).rejects.toThrow('must recover');
    await expect(owner.recover()).rejects.toThrow('verify recovery capability');

    await owner.assertRecoverySupported();
    const recovering = owner.recover();
    await expect(owner.recover()).rejects.toThrow('nested or concurrent mutations');
    await expect(recovering).resolves.toBe(false);

    const verificationStarted = createDeferred();
    const verificationFinished = createDeferred();
    const commit = owner.commit([mutation], async () => {
      verificationStarted.resolve();
      await verificationFinished.promise;
    });
    mutation.content = 'caller mutation after admission\n';
    await verificationStarted.promise;
    await expect(owner.commit([mutation], async () => undefined)).rejects.toThrow(
      'nested or concurrent mutations'
    );
    verificationFinished.resolve();
    await expect(commit).resolves.toBe(true);
    await expect(owner.files.readRequired(paths.workbenchHtmlPath)).resolves.toBe(
      'first committed replacement\n'
    );
  });

  await expect(fs.readFile(paths.workbenchHtmlPath, 'utf8')).resolves.toBe(
    'first committed replacement\n'
  );
});

test('a failed transaction poisons later mutations but keeps scoped reads available for failure status', async () => {
  const appRoot = await createAppRoot('failure-status');
  const paths = buildIslandPatchPaths(appRoot);
  const mutation: FileMutation = {
    filePath: paths.workbenchHtmlPath,
    content: 'replacement that must roll back\n',
    expectedContent: ORIGINAL_HTML,
  };

  await withIslandFileOwner(appRoot, 'v4', async (owner) => {
    await owner.assertRecoverySupported();
    await owner.recover();
    await expect(
      owner.commit([mutation], async () => {
        throw new Error('verification failed');
      })
    ).rejects.toThrow('verification failed');

    await expect(owner.files.readRequired(paths.workbenchHtmlPath)).resolves.toBe(ORIGINAL_HTML);
    await expect(owner.commit([mutation], async () => undefined)).rejects.toThrow(
      'cannot be reused'
    );
  });
});

test('reader rejects use after its locked owner scope closes', async () => {
  const appRoot = await createAppRoot('closed-reader');
  const paths = buildIslandPatchPaths(appRoot);
  let escapedFiles: IslandFileReader | undefined;

  await withIslandFileOwner(appRoot, 'v4', async (owner) => {
    escapedFiles = owner.files;
  });

  expect(escapedFiles).toBeDefined();
  await expect(escapedFiles!.readRequired(paths.workbenchHtmlPath)).rejects.toThrow(
    'escaped its locked scope'
  );
});

test('an unawaited commit is stopped and rolled back even when its verifier has no owner reads', async () => {
  const appRoot = await createAppRoot('escaped-commit');
  const paths = buildIslandPatchPaths(appRoot);
  const mutation: FileMutation = {
    filePath: paths.workbenchHtmlPath,
    content: 'escaped replacement\n',
    expectedContent: ORIGINAL_HTML,
  };
  const verificationStarted = createDeferred();
  const verificationFinished = createDeferred();

  const ownerScope = withIslandFileOwner(appRoot, 'v4', async (owner) => {
    await owner.assertRecoverySupported();
    await owner.recover();
    void owner.commit([mutation], async () => {
      verificationStarted.resolve();
      await verificationFinished.promise;
    });
    await verificationStarted.promise;
  });

  await verificationStarted.promise;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  verificationFinished.resolve();
  await expect(ownerScope).rejects.toThrow('closing and rejects new operations');

  await expect(fs.readFile(paths.workbenchHtmlPath, 'utf8')).resolves.toBe(ORIGINAL_HTML);
  await expect(fs.access(paths.transactionJournalPath)).rejects.toThrow();
});

const ORIGINAL_HTML = '<html>original Island workbench</html>\n';
const ORIGINAL_PRODUCT = '{"checksums":{}}\n';

test('a callback failure and detached mutation failure retain both causes and facts', async () => {
  const appRoot = await createAppRoot('escaped-commit-after-action-failure');
  const paths = buildIslandPatchPaths(appRoot);
  const mutation: FileMutation = {
    filePath: paths.workbenchHtmlPath,
    content: 'escaped replacement\\n',
    expectedContent: ORIGINAL_HTML,
  };
  const actionFailure = Object.assign(new Error('callback failed after registry publication'), {
    registryChanged: true,
  });
  const verificationStarted = createDeferred();
  const verificationFinished = createDeferred();

  const ownerScope = withIslandFileOwner(appRoot, 'v4', async (owner) => {
    await owner.assertRecoverySupported();
    await owner.recover();
    void owner.commit([mutation], async () => {
      verificationStarted.resolve();
      await verificationFinished.promise;
    });
    await verificationStarted.promise;
    throw actionFailure;
  });

  await verificationStarted.promise;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  verificationFinished.resolve();

  let reportedFailure: unknown;
  try {
    await ownerScope;
  } catch (error) {
    reportedFailure = error;
  }

  expect(reportedFailure).toBeInstanceOf(IslandPartialMutationError);
  expect(reportedFailure).toMatchObject({ registryChanged: true });
  const causes = (reportedFailure as IslandPartialMutationError).cause;
  expect(causes).toBeInstanceOf(AggregateError);
  expect((causes as AggregateError).errors).toContain(actionFailure);
  expect((causes as AggregateError).errors).toHaveLength(2);
  await expect(fs.readFile(paths.workbenchHtmlPath, 'utf8')).resolves.toBe(ORIGINAL_HTML);
  await expect(fs.access(paths.transactionJournalPath)).rejects.toThrow();
});

function createDeferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((fulfill) => {
      resolve = fulfill;
    }),
    resolve: () => resolve(),
  };
}

async function createAppRoot(name: string): Promise<string> {
  const appRoot = path.join(testRoot, name);
  const paths = buildIslandPatchPaths(appRoot);
  await fs.mkdir(paths.workbenchDirPath, { recursive: true });
  await fs.writeFile(paths.workbenchHtmlPath, ORIGINAL_HTML, 'utf8');
  await fs.writeFile(paths.productJsonPath, ORIGINAL_PRODUCT, 'utf8');
  return appRoot;
}
