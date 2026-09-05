import {
  canonicalizeAppRoot,
  lstatIfExists,
  type RegularFileGeneration,
  writeDurableJsonFile,
  syncFile,
  writeDurableFileExclusive,
  readRegularFileGeneration,
  sameRegularFileGeneration,
  restoreRetiredGeneration,
  syncDirectories,
  readDurableMetadataGeneration,
  serializeDurableJson,
  settleDurableMetadataPublication,
  removeFileDurably,
  sha256Base64,
  readTextFileIfExists,
  pathExists,
} from './islandFileSystem.js';
import { type IslandFileTransactionProtocol, exchangeIslandPaths } from './islandPlatform.js';
import {
  IslandShellFailure,
  IslandPartialMutationError,
  isAlreadyExistsError,
  combineIslandFailureCodes,
  type IslandTransactionHealth,
  isPermissionError,
  describeIslandShellFailure,
} from './islandShellContract.js';
import crypto from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { mergeIslandMutationFacts, readIslandMutationFacts } from './islandSupervisorCore.js';
import {
  buildIslandPatchPaths,
  buildIslandRootLockPath,
  type IslandPatchPaths,
} from './islandPatchContract.js';
import { withIslandProcessLock } from './islandProcessLock.js';

export type FileMutation = {
  filePath: string;
  content: string | undefined;
  expectedContent: string | undefined;
};

/**
 * Read-only access to the exact Island installation files. The reader never
 * exposes a filesystem path or descriptor, so planners cannot escape the
 * transaction owner's namespace admission.
 */
export type IslandFileReader = {
  read(filePath: string): Promise<string | undefined>;
  readRequired(filePath: string): Promise<string>;
  exists(filePath: string): Promise<boolean>;
  health(): Promise<IslandTransactionHealth>;
  assertNamespaceCurrent(): Promise<void>;
};

/** A single locked installation lifecycle, from recovery admission through commit. */
export type IslandFileOwner = {
  files: IslandFileReader;
  assertRecoverySupported(): Promise<void>;
  recover(): Promise<boolean>;
  commit(mutations: FileMutation[], verify: () => Promise<void>): Promise<boolean>;
};

/**
 * The physical owner published a generation and then could not prove rollback.
 * Consumers use its mutation facts to preserve the actionable two-cause error.
 */
export class IslandFileTransactionPartialMutationError extends AggregateError {
  readonly changed = true;
  readonly desiredStateChanged = false;
  readonly registryChanged = false;
  readonly physicalChanged = true;
  readonly externalDrift = false;
  readonly incompleteRecovery = true;
  readonly transactionError: unknown;
  readonly rollbackError: unknown;

  constructor(transactionError: unknown, rollbackError: unknown) {
    super(
      [transactionError, rollbackError],
      'Tyrian file transaction and rollback both failed after physical mutation was attempted.'
    );
    this.name = 'IslandFileTransactionPartialMutationError';
    this.transactionError = transactionError;
    this.rollbackError = rollbackError;
  }
}

/** Descriptor anchors remain an implementation detail of the physical owner. */
type IslandPatchFileSystem = {
  appRoot: string;
  paths: IslandPatchPaths;
  appRootHandle: FileHandle;
  workbenchHandle: FileHandle;
  pathFor(filePath: string): string;
  parentDescriptorFor(filePath: string): number;
  assertNamespaceCurrent(): Promise<void>;
  close(): Promise<void>;
};

type PreparedFileMutation = FileMutation & {
  backupPath: string;
  changed: boolean;
  existed: boolean;
  originalMode: number | undefined;
  originalDevice: string | undefined;
  originalInode: string | undefined;
  originalContent: string | undefined;
  /** Existing files deleted by restore retain their original generation here. */
  retiredPath: string | undefined;
  /** Existing files replaced by apply exchange this desired candidate atomically. */
  publicationPath: string | undefined;
  stagedPath: string | undefined;
};

type FileTransactionEntryV4 = {
  filePath: string;
  backupPath: string;
  stagedPath: string | undefined;
  existed: boolean;
  originalChecksum: string | null;
  desiredChecksum: string | null;
  originalMode: number | undefined;
  originalDevice: string | undefined;
  originalInode: string | undefined;
  retiredPath: string;
};

type FileTransactionEntryV5 = {
  filePath: string;
  backupPath: string;
  stagedPath: string | undefined;
  existed: boolean;
  originalChecksum: string | null;
  desiredChecksum: string | null;
  originalMode: number | undefined;
  originalDevice: string | undefined;
  originalInode: string | undefined;
  /**
   * Before exchange this is a hardlink of stagedPath (desired). After an
   * atomic exchange it is the retired original generation. It is deliberately
   * not renamed: its inode establishes which side of the exchange survived.
   */
  publicationPath: string | undefined;
  /** Only destructive sidecar removal uses a classic retired path. */
  retiredPath: string | undefined;
};

type FileTransactionJournalV4 = {
  version: 4;
  id: string;
  appRoot: string;
  phase: 'preparing' | 'prepared' | 'committing' | 'verified';
  entries: FileTransactionEntryV4[];
};

type FileTransactionJournalV5 = {
  version: 5;
  id: string;
  appRoot: string;
  phase: 'preparing' | 'prepared' | 'committing' | 'verified';
  recovery?: FileTransactionRecoveryAttempt;
  entries: FileTransactionEntryV5[];
};

type FileTransactionRecoveryAttempt = {
  id: string;
  previousId?: string;
  phase: 'fencing' | 'ready' | 'complete';
};

type FileTransactionJournal = FileTransactionJournalV4 | FileTransactionJournalV5;

type FileTransactionEntry = FileTransactionJournal['entries'][number];

/**
 * Create a read-only view of one visible Island installation. It intentionally
 * holds no descriptor or lock and performs no recovery or durable settlement.
 */
export function readIslandInstallationFiles(appRoot: string): IslandFileReader {
  return createIslandFileReader(appRoot, undefined, (operation) => operation());
}

/**
 * Own a complete mutable Island installation lifecycle. The caller receives no
 * raw filesystem capability, so every physical change must first pass this
 * owner's recovery and admitted-target checks.
 */
export async function withIslandFileOwner<T>(
  appRoot: string,
  transactionProtocol: IslandFileTransactionProtocol,
  action: (owner: IslandFileOwner) => Promise<T>
): Promise<T> {
  const canonicalAppRoot = await canonicalizeAppRoot(appRoot);
  await assertPatchPathAncestorsOwned(canonicalAppRoot);
  const fileSystem =
    process.platform === 'linux' ? await openIslandPatchFileSystem(canonicalAppRoot) : undefined;

  try {
    const claimPath =
      fileSystem?.pathFor(buildIslandRootLockPath(canonicalAppRoot)) ??
      buildIslandRootLockPath(canonicalAppRoot);
    return await withIslandProcessLock(claimPath, async () => {
      await assertIslandPatchNamespaceCurrent(canonicalAppRoot, fileSystem);
      const scope = createIslandFileOwner(canonicalAppRoot, transactionProtocol, fileSystem);
      let actionSucceeded = false;
      let actionValue: T;
      let actionError: unknown;
      try {
        actionValue = await action(scope.owner);
        actionSucceeded = true;
      } catch (error) {
        actionError = error;
      }

      let closeSucceeded = false;
      let closeError: unknown;
      try {
        await scope.close();
        closeSucceeded = true;
      } catch (error) {
        closeError = error;
      }

      // A callback's failure is already its causal result. Closing reports an
      // operation that escaped a successful callback. If both paths failed,
      // retain both causes and their mutation facts, including `throw undefined`.
      if (!actionSucceeded) {
        if (!closeSucceeded) {
          const causes = new AggregateError(
            [actionError, closeError],
            'Tyrian Island owner callback and escaped mutation both failed.'
          );
          throw new IslandPartialMutationError(
            'Tyrian Island owner callback and escaped mutation both failed.',
            mergeIslandMutationFacts(
              readIslandMutationFacts(actionError),
              readIslandMutationFacts(closeError)
            ),
            { cause: causes }
          );
        }
        throw actionError;
      }
      if (!closeSucceeded) throw closeError;
      return actionValue!;
    });
  } finally {
    await fileSystem?.close();
  }
}

function createIslandFileOwner(
  appRoot: string,
  transactionProtocol: IslandFileTransactionProtocol,
  fileSystem: IslandPatchFileSystem | undefined
): { owner: IslandFileOwner; close(): Promise<void> } {
  let acceptingOperations = true;
  let state: 'active' | 'failed' | 'closed' = 'active';
  let recoverySupportAsserted = false;
  let recovered = false;
  let mutationInProgress = false;
  let hasLifecycleFailure = false;
  let lifecycleFailure: unknown;
  const pendingOperations = new Map<Promise<unknown>, 'read' | 'lifecycle' | 'mutation'>();

  const assertReadable = (): void => {
    if (state === 'closed') {
      throw new Error('Tyrian Island file owner escaped its locked scope.');
    }
    if (!acceptingOperations) {
      throw new Error('Tyrian Island file owner is closing and rejects new operations.');
    }
  };
  const assertMutable = (): void => {
    assertReadable();
    if (state === 'failed') {
      throw new Error('Tyrian Island file owner cannot be reused after a transaction failure.');
    }
  };
  const failScope = (error: unknown): never => {
    state = 'failed';
    throw error;
  };
  const runOperation = <T>(
    kind: 'read' | 'lifecycle' | 'mutation',
    operation: () => Promise<T>
  ): Promise<T> => {
    let pending: Promise<T>;
    try {
      if (kind === 'read') assertReadable();
      else assertMutable();
      // Invoke immediately: commit snapshots mutable caller input before any
      // awaited namespace or journal operation can observe a later mutation.
      pending = Promise.resolve(operation());
    } catch (error) {
      pending = Promise.reject(error);
    }
    pendingOperations.set(pending, kind);
    void pending.then(
      () => {
        pendingOperations.delete(pending);
      },
      (error) => {
        pendingOperations.delete(pending);
        if (kind !== 'read' && !hasLifecycleFailure) {
          lifecycleFailure = error;
          hasLifecycleFailure = true;
        }
      }
    );
    return pending;
  };
  const files = createIslandFileReader(appRoot, fileSystem, (operation) =>
    runOperation('read', operation)
  );

  const owner: IslandFileOwner = Object.freeze({
    files,
    assertRecoverySupported: () =>
      runOperation('lifecycle', async () => {
        try {
          await assertIslandRecoverySupported(appRoot, transactionProtocol, fileSystem);
          recoverySupportAsserted = true;
        } catch (error) {
          failScope(error);
        }
      }),
    recover: () => {
      try {
        assertMutable();
        if (!recoverySupportAsserted) {
          throw new Error(
            'Tyrian Island file owner must verify recovery capability before mutating registry state or recovering files.'
          );
        }
        if (recovered) {
          throw new Error('Tyrian Island file owner already completed recovery for this scope.');
        }
        if (mutationInProgress) {
          throw new Error('Tyrian Island file owner rejects nested or concurrent mutations.');
        }
      } catch (error) {
        return Promise.reject(error);
      }
      mutationInProgress = true;
      return runOperation('mutation', async () => {
        try {
          // Recheck while holding the root lock so a newly visible journal cannot
          // route a portable v4 owner into an unowned v5 recovery.
          await assertIslandRecoverySupported(appRoot, transactionProtocol, fileSystem);
          const changed = await recoverRootFileTransactions(appRoot, fileSystem);
          recovered = true;
          return changed;
        } catch (error) {
          return failScope(error);
        } finally {
          mutationInProgress = false;
        }
      });
    },
    commit: (mutations, verify) => {
      let admittedMutations: readonly FileMutation[];
      try {
        assertMutable();
        if (!recovered) {
          throw new Error(
            'Tyrian Island file owner must recover before committing a file transaction.'
          );
        }
        if (mutationInProgress) {
          throw new Error('Tyrian Island file owner rejects nested or concurrent mutations.');
        }
        // Freeze the caller's values before an await can give it another turn.
        admittedMutations = admitIslandMutations(appRoot, mutations);
      } catch (error) {
        return Promise.reject(error);
      }
      mutationInProgress = true;
      return runOperation('mutation', async () => {
        try {
          await assertIslandPatchNamespaceCurrent(appRoot, fileSystem);
          // The callback may have returned while namespace inspection yielded.
          // Never create durable transaction evidence after the owner begins
          // closing its lock and descriptor scope.
          assertReadable();
          return await commitFileTransactionWithFileSystem(
            islandTransactionJournalPath(appRoot),
            appRoot,
            admittedMutations,
            async () => {
              // The private transaction owns rollback. These two checks make
              // an abandoned verifier enter that rollback path even when the
              // verifier never reaches through the public reader.
              assertReadable();
              await verify();
              assertReadable();
            },
            transactionProtocol,
            fileSystem
          );
        } catch (error) {
          return failScope(error);
        } finally {
          mutationInProgress = false;
        }
      });
    },
  });

  return {
    owner,
    async close(): Promise<void> {
      acceptingOperations = false;
      const escapedMutation = [...pendingOperations.values()].some((kind) => kind !== 'read');
      while (pendingOperations.size > 0) {
        await Promise.all(
          [...pendingOperations.keys()].map((pending) =>
            pending.then(
              () => undefined,
              () => undefined
            )
          )
        );
      }
      state = 'closed';
      if (!escapedMutation) return;
      if (hasLifecycleFailure) throw lifecycleFailure;
      throw new Error(
        'Tyrian Island file owner rejected a mutation that escaped its callback without awaiting completion.'
      );
    },
  };
}

type IslandFileReaderOperation = <T>(operation: () => Promise<T>) => Promise<T>;

function createIslandFileReader(
  appRoot: string,
  fileSystem: IslandPatchFileSystem | undefined,
  runOperation: IslandFileReaderOperation
): IslandFileReader {
  const admittedTargets = islandTransactionAllowedTargets(appRoot);
  const admittedOperationPath = async (filePath: string): Promise<string> => {
    const resolvedPath = path.resolve(filePath);
    if (!admittedTargets.has(resolvedPath)) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian Island file reader does not admit '${filePath}'.`
      );
    }
    await assertIslandPatchNamespaceCurrent(appRoot, fileSystem);
    return fileSystem?.pathFor(resolvedPath) ?? resolvedPath;
  };
  const assertNamespaceCurrent = (): Promise<void> =>
    runOperation(async () => {
      await assertIslandPatchNamespaceCurrent(appRoot, fileSystem);
    });

  return Object.freeze({
    read: (filePath) =>
      runOperation(async () => readTextFileIfExists(await admittedOperationPath(filePath))),
    readRequired: (filePath) =>
      runOperation(async () => fs.readFile(await admittedOperationPath(filePath), 'utf8')),
    exists: (filePath) =>
      runOperation(async () => pathExists(await admittedOperationPath(filePath))),
    health: () =>
      runOperation(async () => {
        // Health must classify malformed journal evidence itself; a read-only
        // preflight must not turn that durable evidence into a generic access
        // failure before the journal inspector can report it.
        if (fileSystem === undefined) await assertIslandPatchAncestorsOwned(appRoot);
        else await fileSystem.assertNamespaceCurrent();
        return inspectIslandTransactionHealth(
          islandTransactionJournalPath(appRoot),
          appRoot,
          fileSystem
        );
      }),
    assertNamespaceCurrent,
  });
}

function admitIslandMutations(appRoot: string, mutations: FileMutation[]): readonly FileMutation[] {
  if (!Array.isArray(mutations)) {
    throw new IslandShellFailure(
      'blocked',
      'Tyrian Island file transaction requires a mutation list.'
    );
  }
  const admittedTargets = islandTransactionAllowedTargets(appRoot);
  const seenTargets = new Set<string>();
  const admittedMutations: FileMutation[] = [];
  for (const mutation of mutations) {
    if (
      typeof mutation !== 'object' ||
      mutation === null ||
      typeof mutation.filePath !== 'string'
    ) {
      throw new IslandShellFailure(
        'blocked',
        'Tyrian Island file transaction has an invalid target.'
      );
    }
    const { content, expectedContent } = mutation;
    const targetPath = path.resolve(mutation.filePath);
    if (!admittedTargets.has(targetPath)) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian Island file transaction does not admit '${mutation.filePath}'.`
      );
    }
    if (seenTargets.has(targetPath)) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian Island file transaction contains duplicate target '${mutation.filePath}'.`
      );
    }
    if (
      (content !== undefined && typeof content !== 'string') ||
      (expectedContent !== undefined && typeof expectedContent !== 'string')
    ) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian Island file transaction has invalid content for '${mutation.filePath}'.`
      );
    }
    seenTargets.add(targetPath);
    admittedMutations.push(
      Object.freeze({ filePath: targetPath, content, expectedContent }) as FileMutation
    );
  }
  return Object.freeze(admittedMutations);
}

/** A v4 owner must leave an interrupted v5 journal entirely untouched. */
async function assertIslandRecoverySupported(
  appRoot: string,
  transactionProtocol: IslandFileTransactionProtocol,
  fileSystem: IslandPatchFileSystem | undefined
): Promise<void> {
  if (transactionProtocol === 'v5') return;

  await assertIslandPatchNamespaceCurrent(appRoot, fileSystem);
  const transaction = await inspectIslandTransactionHealth(
    islandTransactionJournalPath(appRoot),
    appRoot,
    fileSystem
  );
  if (transaction.kind !== 'recoverable' || transaction.version !== 5) return;

  throw new IslandShellFailure(
    'unsupported',
    `Tyrian Classic UI restore found a pending v5 transaction at '${transaction.journalPath}'. A Linux host with GNU mv --exchange and --no-copy is required to recover it before restore can continue.`,
    { mutation: { incompleteRecovery: true } }
  );
}

async function assertIslandPatchNamespaceCurrent(
  appRoot: string,
  fileSystem: IslandPatchFileSystem | undefined
): Promise<void> {
  if (fileSystem === undefined) {
    await assertPatchPathAncestorsOwned(appRoot);
    return;
  }

  await fileSystem.assertNamespaceCurrent();
  for (const targetPath of islandOwnedFilePaths(appRoot)) {
    const stats = await lstatIfExists(fileSystem.pathFor(targetPath));
    if (stats !== undefined && (!stats.isFile() || stats.isSymbolicLink())) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian patch target is not an owned regular file at '${targetPath}'.`
      );
    }
  }
}

/**
 * Descriptor anchoring is private because a caller that can construct procfs
 * paths can bypass the admission and lifecycle checks above.
 */
async function openIslandPatchFileSystem(appRoot: string): Promise<IslandPatchFileSystem> {
  if (process.platform !== 'linux') {
    throw new IslandShellFailure(
      'unsupported',
      'Descriptor-anchored Island filesystem mutation is supported only on Linux.'
    );
  }

  try {
    await fs.access('/proc/self/fd');
  } catch (error) {
    throw new IslandShellFailure(
      'unsupported',
      'Descriptor-anchored Island filesystem mutation requires Linux procfs.',
      { cause: error }
    );
  }

  await assertPatchPathAncestorsOwned(appRoot);
  const paths = buildIslandPatchPaths(appRoot);
  const directoryFlags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
  const appRootHandle = await fs.open(appRoot, directoryFlags);
  let currentHandle: FileHandle | undefined;
  let workbenchHandle: FileHandle | undefined;

  try {
    const expectedRoot = await fs.lstat(appRoot);
    const openedRoot = await appRootHandle.stat();
    if (
      !expectedRoot.isDirectory() ||
      expectedRoot.isSymbolicLink() ||
      expectedRoot.dev !== openedRoot.dev ||
      expectedRoot.ino !== openedRoot.ino
    ) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian app root changed during filesystem admission at '${appRoot}'.`
      );
    }

    currentHandle = appRootHandle;
    for (const segment of path.relative(appRoot, paths.workbenchDirPath).split(path.sep)) {
      const childHandle = await fs.open(
        `/proc/self/fd/${currentHandle.fd}/${segment}`,
        directoryFlags
      );
      if (currentHandle !== appRootHandle) await currentHandle.close();
      currentHandle = childHandle;
    }
    workbenchHandle = currentHandle;
    currentHandle = undefined;

    const admittedWorkbenchHandle = workbenchHandle;
    const fileSystem: IslandPatchFileSystem = {
      appRoot,
      paths,
      appRootHandle,
      workbenchHandle: admittedWorkbenchHandle,
      pathFor(filePath: string): string {
        const resolved = path.resolve(filePath);
        const parent = path.dirname(resolved);
        if (parent === appRoot)
          return `/proc/self/fd/${appRootHandle.fd}/${path.basename(resolved)}`;
        if (parent === paths.workbenchDirPath) {
          return `/proc/self/fd/${admittedWorkbenchHandle.fd}/${path.basename(resolved)}`;
        }
        throw new IslandShellFailure(
          'blocked',
          `Tyrian patch mutation escapes its admitted directories at '${filePath}'.`
        );
      },
      parentDescriptorFor(filePath: string): number {
        const resolved = path.resolve(filePath);
        const parent = path.dirname(resolved);
        if (parent === appRoot) return appRootHandle.fd;
        if (parent === paths.workbenchDirPath) return admittedWorkbenchHandle.fd;
        throw new IslandShellFailure(
          'blocked',
          `Tyrian atomic publication escapes its admitted directories at '${filePath}'.`
        );
      },
      async assertNamespaceCurrent(): Promise<void> {
        const [visibleRoot, heldRoot, visibleWorkbench, heldWorkbench] = await Promise.all([
          fs.lstat(appRoot),
          appRootHandle.stat(),
          fs.lstat(paths.workbenchDirPath),
          admittedWorkbenchHandle.stat(),
        ]);
        if (
          !visibleRoot.isDirectory() ||
          visibleRoot.isSymbolicLink() ||
          visibleRoot.dev !== heldRoot.dev ||
          visibleRoot.ino !== heldRoot.ino ||
          !visibleWorkbench.isDirectory() ||
          visibleWorkbench.isSymbolicLink() ||
          visibleWorkbench.dev !== heldWorkbench.dev ||
          visibleWorkbench.ino !== heldWorkbench.ino
        ) {
          throw new IslandShellFailure(
            'blocked',
            `Tyrian patch namespace changed during mutation under '${appRoot}'.`
          );
        }
      },
      async close(): Promise<void> {
        await Promise.allSettled([admittedWorkbenchHandle.close(), appRootHandle.close()]);
      },
    };

    await assertIslandPatchNamespaceCurrent(appRoot, fileSystem);
    return fileSystem;
  } catch (error) {
    if (currentHandle !== undefined && currentHandle !== appRootHandle) {
      await currentHandle.close().catch(() => undefined);
    }
    if (workbenchHandle !== undefined) {
      await workbenchHandle.close().catch(() => undefined);
    }
    await appRootHandle.close().catch(() => undefined);
    throw error;
  }
}

async function commitFileTransactionWithFileSystem(
  journalPath: string,
  appRoot: string,
  mutations: readonly FileMutation[],
  verify: () => Promise<void>,
  transactionProtocol: IslandFileTransactionProtocol,
  fileSystem: IslandPatchFileSystem | undefined
): Promise<boolean> {
  if (transactionProtocol === 'v5' && fileSystem === undefined) {
    throw new IslandShellFailure(
      'unsupported',
      'Atomic Island app-file publication requires the Linux descriptor-anchored filesystem.'
    );
  }
  const targets = new Set<string>();
  const prepared: PreparedFileMutation[] = [];
  const transactionId = crypto.randomUUID();

  await assertIslandPatchNamespaceCurrent(appRoot, fileSystem);

  for (const mutation of mutations) {
    if (targets.has(mutation.filePath)) {
      throw new Error(`Tyrian file transaction contains duplicate target '${mutation.filePath}'.`);
    }
    targets.add(mutation.filePath);

    const operationPath = fileSystem?.pathFor(mutation.filePath) ?? mutation.filePath;
    const stats = await lstatIfExists(operationPath);

    if (stats?.isDirectory()) {
      throw new Error(`Tyrian file transaction target is a directory at '${mutation.filePath}'.`);
    }

    if (stats?.isSymbolicLink()) {
      throw new Error(
        `Tyrian file transaction target is a symbolic link at '${mutation.filePath}'.`
      );
    }

    const currentContent =
      stats === undefined ? undefined : await fs.readFile(operationPath, 'utf8');

    if (currentContent !== mutation.expectedContent) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian transaction input changed before preparation at '${mutation.filePath}'.`
      );
    }

    const changed = currentContent !== mutation.content;

    prepared.push({
      ...mutation,
      backupPath: transactionSiblingPath(mutation.filePath, transactionId, 'backup'),
      changed,
      existed: stats !== undefined,
      originalMode: stats === undefined ? undefined : Number(stats.mode),
      originalDevice: stats === undefined ? undefined : String(stats.dev),
      originalInode: stats === undefined ? undefined : String(stats.ino),
      originalContent: currentContent,
      retiredPath: transactionSiblingPath(mutation.filePath, transactionId, 'retired'),
      publicationPath:
        transactionProtocol === 'v5' &&
        changed &&
        stats !== undefined &&
        mutation.content !== undefined
          ? transactionSiblingPath(mutation.filePath, transactionId, 'publication')
          : undefined,
      stagedPath:
        changed && mutation.content !== undefined
          ? transactionSiblingPath(mutation.filePath, transactionId, 'stage')
          : undefined,
    });
  }

  const changedMutations = prepared.filter(({ changed }) => changed);

  if (changedMutations.length === 0) {
    await verify();
    return false;
  }

  let journal = buildFileTransactionJournal(
    appRoot,
    transactionId,
    'preparing',
    changedMutations,
    transactionProtocol
  );
  let durableJournalGeneration: RegularFileGeneration = { kind: 'absent' };
  let physicalMutationAttempted = false;
  durableJournalGeneration = await writeDurableJsonFile(
    fileSystem?.pathFor(journalPath) ?? journalPath,
    journal,
    durableJournalGeneration
  );

  try {
    for (const mutation of changedMutations) {
      if (mutation.existed) {
        await fs.copyFile(
          fileSystem?.pathFor(mutation.filePath) ?? mutation.filePath,
          fileSystem?.pathFor(mutation.backupPath) ?? mutation.backupPath,
          fsConstants.COPYFILE_EXCL
        );
        await syncFile(fileSystem?.pathFor(mutation.backupPath) ?? mutation.backupPath);
      }

      if (mutation.stagedPath !== undefined) {
        const stagedOperationPath = fileSystem?.pathFor(mutation.stagedPath) ?? mutation.stagedPath;
        await writeDurableFileExclusive(stagedOperationPath, mutation.content!);

        if (mutation.originalMode !== undefined) {
          await fs.chmod(stagedOperationPath, mutation.originalMode);
          await syncFile(stagedOperationPath);
        }
      }

      if (mutation.publicationPath !== undefined) {
        const stagedPath = fileSystem?.pathFor(mutation.stagedPath!) ?? mutation.stagedPath!;
        const publicationPath =
          fileSystem?.pathFor(mutation.publicationPath) ?? mutation.publicationPath;
        await fs.link(stagedPath, publicationPath);
        await assertPublicationCandidateGeneration(mutation, fileSystem);
      }
    }

    await syncPatchMutationDirectories(
      fileSystem,
      changedMutations.map(({ filePath }) => filePath)
    );

    journal = { ...journal, phase: 'prepared' };
    durableJournalGeneration = await writeDurableJsonFile(
      fileSystem?.pathFor(journalPath) ?? journalPath,
      journal,
      durableJournalGeneration
    );

    for (const mutation of changedMutations) {
      await assertPreparedMutationGeneration(mutation, fileSystem);
    }

    journal = { ...journal, phase: 'committing' };
    durableJournalGeneration = await writeDurableJsonFile(
      fileSystem?.pathFor(journalPath) ?? journalPath,
      journal,
      durableJournalGeneration
    );

    physicalMutationAttempted = true;
    for (const mutation of changedMutations) {
      await publishPreparedMutation(mutation, fileSystem);
    }

    await syncPatchMutationDirectories(
      fileSystem,
      changedMutations.map(({ filePath }) => filePath)
    );

    await fileSystem?.assertNamespaceCurrent();
    await verify();
    await fileSystem?.assertNamespaceCurrent();
    journal = { ...journal, phase: 'verified' };
    await writeDurableJsonFile(
      fileSystem?.pathFor(journalPath) ?? journalPath,
      journal,
      durableJournalGeneration
    );
  } catch (error) {
    const durableJournal = await tryReadFileTransactionJournal(
      journalPath,
      targets,
      appRoot,
      fileSystem
    );

    try {
      if (durableJournal !== undefined) {
        await rollbackFileTransaction(journalPath, durableJournal, fileSystem);
      }
    } catch (rollbackError) {
      if (physicalMutationAttempted) {
        throw new IslandFileTransactionPartialMutationError(error, rollbackError);
      }
      throw new AggregateError(
        [error, rollbackError],
        'Tyrian file transaction and rollback both failed'
      );
    }
    throw error;
  }

  try {
    await removeTemporaryFilesBeforeJournal(journalPath, journal, fileSystem);
  } catch (error) {
    throw new IslandPartialMutationError(
      `Tyrian file transaction verified its app-file changes, but cleanup remains incomplete: ${error instanceof Error ? error.message : String(error)}`,
      { physicalChanged: true, incompleteRecovery: true },
      { cause: error }
    );
  }
  return true;
}

function buildFileTransactionJournal(
  appRoot: string,
  id: string,
  phase: FileTransactionJournal['phase'],
  mutations: PreparedFileMutation[],
  transactionProtocol: IslandFileTransactionProtocol
): FileTransactionJournal {
  if (transactionProtocol === 'v5') {
    return {
      version: 5,
      id,
      appRoot,
      phase,
      entries: mutations.map(
        ({
          filePath,
          backupPath,
          stagedPath,
          existed,
          originalContent,
          content,
          originalMode,
          originalDevice,
          originalInode,
          publicationPath,
          retiredPath,
        }) => ({
          filePath,
          backupPath,
          stagedPath,
          existed,
          originalChecksum: checksumOrNull(originalContent),
          desiredChecksum: checksumOrNull(content),
          originalMode,
          originalDevice,
          originalInode,
          publicationPath,
          retiredPath: content === undefined ? retiredPath : undefined,
        })
      ),
    };
  }

  return {
    version: 4,
    id,
    appRoot,
    phase,
    entries: mutations.map(
      ({
        filePath,
        backupPath,
        stagedPath,
        existed,
        originalContent,
        content,
        originalMode,
        originalDevice,
        originalInode,
        retiredPath,
      }) => ({
        filePath,
        backupPath,
        stagedPath,
        existed,
        originalChecksum: checksumOrNull(originalContent),
        desiredChecksum: checksumOrNull(content),
        originalMode,
        originalDevice,
        originalInode,
        retiredPath: retiredPath!,
      })
    ),
  };
}

async function assertPreparedMutationGeneration(
  mutation: PreparedFileMutation,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const operationPath = fileSystem?.pathFor(mutation.filePath) ?? mutation.filePath;
  const currentContent = await readTransactionTarget(operationPath, mutation.filePath);
  const currentStats = await lstatIfExists(operationPath);

  if (
    currentContent !== mutation.originalContent ||
    (currentStats === undefined ? undefined : String(currentStats.dev)) !==
      mutation.originalDevice ||
    (currentStats === undefined ? undefined : String(currentStats.ino)) !==
      mutation.originalInode ||
    (currentStats === undefined ? undefined : Number(currentStats.mode)) !== mutation.originalMode
  ) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian transaction input changed before replacement at '${mutation.filePath}'.`
    );
  }
}

async function publishPreparedMutation(
  mutation: PreparedFileMutation,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  await assertPreparedMutationGeneration(mutation, fileSystem);
  const targetPath = fileSystem?.pathFor(mutation.filePath) ?? mutation.filePath;

  if (mutation.publicationPath !== undefined) {
    if (fileSystem === undefined) {
      throw new IslandShellFailure(
        'unsupported',
        'Atomic Island app-file publication requires the Linux descriptor-anchored filesystem.'
      );
    }
    await assertPublicationCandidateGeneration(mutation, fileSystem);
    await fileSystem.assertNamespaceCurrent();
    exchangeIslandPaths({
      sourceParentDescriptor: fileSystem.parentDescriptorFor(mutation.publicationPath),
      sourceLeaf: path.basename(mutation.publicationPath),
      targetParentDescriptor: fileSystem.parentDescriptorFor(mutation.filePath),
      targetLeaf: path.basename(mutation.filePath),
    });
    await fileSystem.assertNamespaceCurrent();

    const [published, retired, staged] = await Promise.all([
      readRegularFileGeneration(targetPath, `published transaction target '${mutation.filePath}'`),
      readRegularFileGeneration(
        fileSystem.pathFor(mutation.publicationPath),
        `retired transaction generation '${mutation.publicationPath}'`
      ),
      readRegularFileGeneration(
        fileSystem.pathFor(mutation.stagedPath!),
        `staged transaction generation '${mutation.stagedPath}'`
      ),
    ]);
    if (
      !isOriginalPreparedMutationGeneration(retired, mutation) ||
      !sameRegularFileGeneration(published, staged)
    ) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian transaction target changed across the atomic publication boundary at '${mutation.filePath}'.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    return;
  }

  if (mutation.existed) {
    const retiredPublicPath = mutation.retiredPath!;
    const retiredPath = fileSystem?.pathFor(retiredPublicPath) ?? retiredPublicPath;
    await fs.rename(targetPath, retiredPath);
    const [retiredContent, retiredStats] = await Promise.all([
      readTransactionTarget(retiredPath, mutation.filePath),
      fs.lstat(retiredPath),
    ]);
    if (
      retiredContent !== mutation.originalContent ||
      String(retiredStats.dev) !== mutation.originalDevice ||
      String(retiredStats.ino) !== mutation.originalInode ||
      Number(retiredStats.mode) !== mutation.originalMode
    ) {
      await restoreRetiredGeneration(retiredPath, targetPath);
      throw new IslandShellFailure(
        'blocked',
        `Tyrian transaction target changed across the retirement boundary at '${mutation.filePath}'.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
  }

  if (mutation.stagedPath !== undefined) {
    const stagedPath = fileSystem?.pathFor(mutation.stagedPath) ?? mutation.stagedPath;
    try {
      await fs.link(stagedPath, targetPath);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      throw new IslandShellFailure(
        'blocked',
        `Tyrian transaction observed a replacement generation before publication at '${mutation.filePath}'.`,
        { cause: error, mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
  }
}

function isOriginalPreparedMutationGeneration(
  generation: RegularFileGeneration,
  mutation: Pick<
    PreparedFileMutation,
    'existed' | 'originalContent' | 'originalDevice' | 'originalInode' | 'originalMode'
  >
): boolean {
  return generation.kind === 'absent'
    ? !mutation.existed
    : checksumOrNull(generation.content) === checksumOrNull(mutation.originalContent) &&
        generation.device === mutation.originalDevice &&
        generation.inode === mutation.originalInode &&
        generation.mode === mutation.originalMode;
}

async function assertPublicationCandidateGeneration(
  mutation: PreparedFileMutation,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  if (mutation.publicationPath === undefined || mutation.stagedPath === undefined) return;
  const [publication, staged] = await Promise.all([
    readRegularFileGeneration(
      fileSystem?.pathFor(mutation.publicationPath) ?? mutation.publicationPath,
      `publication candidate '${mutation.publicationPath}'`
    ),
    readRegularFileGeneration(
      fileSystem?.pathFor(mutation.stagedPath) ?? mutation.stagedPath,
      `staged transaction generation '${mutation.stagedPath}'`
    ),
  ]);
  if (!sameRegularFileGeneration(publication, staged)) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian transaction publication candidate changed before exchange at '${mutation.filePath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
}

async function syncPatchMutationDirectories(
  fileSystem: IslandPatchFileSystem | undefined,
  filePaths: string[]
): Promise<void> {
  if (fileSystem === undefined) {
    await syncDirectories(filePaths.map((filePath) => path.dirname(filePath)));
    return;
  }
  const directories = new Set(filePaths.map((filePath) => path.dirname(filePath)));
  if (directories.has(fileSystem.appRoot)) await fileSystem.appRootHandle.sync();
  if (directories.has(fileSystem.paths.workbenchDirPath)) await fileSystem.workbenchHandle.sync();
}

async function rollbackFileTransaction(
  journalPath: string,
  journal: FileTransactionJournal,
  fileSystem?: IslandPatchFileSystem
): Promise<boolean> {
  if (journal.phase === 'preparing' || journal.phase === 'prepared') {
    await removeTemporaryFilesBeforeJournal(journalPath, journal, fileSystem);
    return false;
  }

  return journal.version === 4
    ? rollbackVersion4FileTransaction(journalPath, journal, fileSystem)
    : rollbackVersion5FileTransaction(journalPath, journal, fileSystem);
}

// Inspection and execution use this same generation evidence. Checksums alone
// cannot distinguish our published inode from an external same-content replacement.
type Version4RecoveryPlan = 'unchanged' | 'restore' | 'replace' | 'remove';

type Version5RecoveryPlan = 'unchanged' | 'reverse-exchange' | 'restore-retired' | 'remove-created';

async function planFileTransactionEntryRecovery(
  version: FileTransactionJournal['version'],
  entry: FileTransactionEntry,
  fileSystem?: IslandPatchFileSystem
): Promise<Version4RecoveryPlan | Version5RecoveryPlan> {
  return version === 5
    ? planVersion5FileTransactionEntryRecovery(entry as FileTransactionEntryV5, fileSystem)
    : planVersion4FileTransactionEntryRecovery(entry as FileTransactionEntryV4, fileSystem);
}

async function planVersion4FileTransactionEntryRecovery(
  entry: FileTransactionEntryV4,
  fileSystem?: IslandPatchFileSystem
): Promise<Version4RecoveryPlan> {
  const targetPath = fileSystem?.pathFor(entry.filePath) ?? entry.filePath;
  const retiredPath = fileSystem?.pathFor(entry.retiredPath) ?? entry.retiredPath;
  const [current, retired] = await Promise.all([
    readRegularFileGeneration(targetPath, `transaction target '${entry.filePath}'`),
    readRegularFileGeneration(retiredPath, `transaction retired generation '${entry.retiredPath}'`),
  ]);
  if (retired.kind === 'present' && !isOriginalTransactionGeneration(retired, entry)) {
    throw new IslandShellFailure(
      'corrupt',
      `Tyrian transaction retired generation changed at '${entry.retiredPath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }
  if (isOriginalTransactionGeneration(current, entry)) return 'unchanged';
  if (current.kind === 'absent' && retired.kind === 'present') return 'restore';
  if (
    current.kind === 'present' &&
    checksumOrNull(current.content) === entry.desiredChecksum &&
    (retired.kind === 'present' || !entry.existed)
  ) {
    if (entry.stagedPath === undefined) {
      throw new IslandShellFailure(
        'corrupt',
        `Tyrian transaction has no staged generation for '${entry.filePath}'.`
      );
    }
    const staged = await readRegularFileGeneration(
      fileSystem?.pathFor(entry.stagedPath) ?? entry.stagedPath,
      `transaction staged generation '${entry.stagedPath}'`
    );
    if (sameRegularFileGeneration(current, staged)) {
      return retired.kind === 'present' ? 'replace' : 'remove';
    }
  }
  throw new IslandShellFailure(
    'blocked',
    `Tyrian transaction recovery found external drift at '${entry.filePath}' and left it untouched.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

async function planVersion5FileTransactionEntryRecovery(
  entry: FileTransactionEntryV5,
  fileSystem?: IslandPatchFileSystem
): Promise<Version5RecoveryPlan> {
  const targetPath = fileSystem?.pathFor(entry.filePath) ?? entry.filePath;
  const target = await readRegularFileGeneration(
    targetPath,
    `transaction target '${entry.filePath}'`
  );

  if (entry.publicationPath !== undefined) {
    if (entry.stagedPath === undefined) {
      throw new IslandShellFailure(
        'corrupt',
        `Tyrian v5 transaction has no staged generation for '${entry.filePath}'.`,
        { mutation: { incompleteRecovery: true } }
      );
    }
    const [publication, staged] = await Promise.all([
      readRegularFileGeneration(
        fileSystem?.pathFor(entry.publicationPath) ?? entry.publicationPath,
        `publication candidate '${entry.publicationPath}'`
      ),
      readRegularFileGeneration(
        fileSystem?.pathFor(entry.stagedPath) ?? entry.stagedPath,
        `staged transaction generation '${entry.stagedPath}'`
      ),
    ]);
    if (!isDesiredTransactionGeneration(staged, entry)) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian v5 staged generation changed at '${entry.stagedPath}' and was left untouched.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    if (
      isOriginalTransactionGeneration(target, entry) &&
      sameRegularFileGeneration(publication, staged)
    ) {
      return 'unchanged';
    }
    if (
      sameRegularFileGeneration(target, staged) &&
      isOriginalTransactionGeneration(publication, entry)
    ) {
      return 'reverse-exchange';
    }
    throw new IslandShellFailure(
      'blocked',
      `Tyrian v5 transaction recovery found external drift at '${entry.filePath}' and left every generation intact.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }

  if (entry.desiredChecksum !== null) {
    if (entry.stagedPath === undefined) {
      throw new IslandShellFailure(
        'corrupt',
        `Tyrian v5 transaction has no staged generation for '${entry.filePath}'.`,
        { mutation: { incompleteRecovery: true } }
      );
    }
    const staged = await readRegularFileGeneration(
      fileSystem?.pathFor(entry.stagedPath) ?? entry.stagedPath,
      `staged transaction generation '${entry.stagedPath}'`
    );
    if (!isDesiredTransactionGeneration(staged, entry)) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian v5 staged generation changed at '${entry.stagedPath}' and was left untouched.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    if (target.kind === 'absent') return 'unchanged';
    if (sameRegularFileGeneration(target, staged)) return 'remove-created';
    throw new IslandShellFailure(
      'blocked',
      `Tyrian v5 transaction recovery found external drift at '${entry.filePath}' and left it untouched.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }

  if (entry.retiredPath === undefined) {
    throw new IslandShellFailure(
      'corrupt',
      `Tyrian v5 transaction has no retired generation path for '${entry.filePath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }
  const retired = await readRegularFileGeneration(
    fileSystem?.pathFor(entry.retiredPath) ?? entry.retiredPath,
    `transaction retired generation '${entry.retiredPath}'`
  );
  if (retired.kind === 'present' && !isOriginalTransactionGeneration(retired, entry)) {
    throw new IslandShellFailure(
      'corrupt',
      `Tyrian transaction retired generation changed at '${entry.retiredPath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }
  if (isOriginalTransactionGeneration(target, entry)) return 'unchanged';
  if (target.kind === 'absent' && retired.kind === 'present') return 'restore-retired';
  throw new IslandShellFailure(
    'blocked',
    `Tyrian v5 transaction recovery found external drift at '${entry.filePath}' and left it untouched.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

function isOriginalTransactionGeneration(
  generation: RegularFileGeneration,
  entry: Pick<
    FileTransactionEntry,
    'existed' | 'originalChecksum' | 'originalDevice' | 'originalInode' | 'originalMode'
  >
): boolean {
  return generation.kind === 'absent'
    ? !entry.existed
    : checksumOrNull(generation.content) === entry.originalChecksum &&
        generation.device === entry.originalDevice &&
        generation.inode === entry.originalInode &&
        generation.mode === entry.originalMode;
}

function isDesiredTransactionGeneration(
  generation: RegularFileGeneration,
  entry: Pick<FileTransactionEntry, 'desiredChecksum'>
): generation is Extract<RegularFileGeneration, { kind: 'present' }> {
  return (
    generation.kind === 'present' && checksumOrNull(generation.content) === entry.desiredChecksum
  );
}

async function rollbackVersion4FileTransaction(
  journalPath: string,
  journal: FileTransactionJournalV4,
  fileSystem?: IslandPatchFileSystem
): Promise<boolean> {
  const failures: unknown[] = [];
  let physicalChanged = false;

  for (const entry of journal.entries.toReversed()) {
    try {
      const targetPath = fileSystem?.pathFor(entry.filePath) ?? entry.filePath;
      const retiredPath = fileSystem?.pathFor(entry.retiredPath) ?? entry.retiredPath;
      const stagedPath =
        entry.stagedPath === undefined
          ? undefined
          : (fileSystem?.pathFor(entry.stagedPath) ?? entry.stagedPath);
      const recovery = await planVersion4FileTransactionEntryRecovery(entry, fileSystem);
      if (recovery === 'unchanged') continue;
      if (recovery === 'replace' || recovery === 'remove') {
        await retireDesiredGeneration(entry, journal.id, targetPath, stagedPath!, fileSystem);
        physicalChanged = true;
      }
      if (recovery === 'restore' || recovery === 'replace') {
        try {
          await fs.link(retiredPath, targetPath);
        } catch (error) {
          if (isAlreadyExistsError(error)) {
            throw new IslandShellFailure(
              'blocked',
              `Tyrian transaction recovery observed a replacement generation at '${entry.filePath}' and left it untouched.`,
              { cause: error, mutation: { externalDrift: true, incompleteRecovery: true } }
            );
          }
          throw error;
        }
        physicalChanged = true;
      }
    } catch (error) {
      failures.push(error);
    }
  }

  try {
    await syncPatchMutationDirectories(
      fileSystem,
      journal.entries.map(({ filePath }) => filePath)
    );
  } catch (error) {
    failures.push(error);
  }

  if (failures.length > 0) {
    throw new IslandShellFailure(
      combineIslandFailureCodes(failures),
      `Tyrian transaction recovery could not safely restore every target: ${failures
        .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
        .join(' ')}`,
      {
        cause: new AggregateError(failures),
        mutation: mergeIslandMutationFacts(
          ...failures.map((failure) => readIslandMutationFacts(failure)),
          { physicalChanged, incompleteRecovery: true }
        ),
      }
    );
  }

  await removeTemporaryFilesBeforeJournal(journalPath, journal, fileSystem);
  return physicalChanged;
}

async function rollbackVersion5FileTransaction(
  journalPath: string,
  journal: FileTransactionJournalV5,
  fileSystem?: IslandPatchFileSystem
): Promise<boolean> {
  let recoveryJournal = journal;
  if (journal.recovery?.phase === 'complete') {
    await assertVersion5RecoveryComplete(journal, fileSystem);
    await removeVersion5RecoveryCandidates(journal, fileSystem);
    await removeTemporaryFilesBeforeJournal(journalPath, journal, fileSystem);
    return false;
  }

  if (journal.entries.some(({ publicationPath }) => publicationPath !== undefined)) {
    recoveryJournal = await beginVersion5RecoveryAttempt(journalPath, journal, fileSystem);
  }

  const failures: unknown[] = [];
  let physicalChanged = false;

  for (const entry of recoveryJournal.entries.toReversed()) {
    try {
      const recoveredEntry = version5RecoveryEntry(entry, recoveryJournal.recovery);
      const recovery = await planVersion5FileTransactionEntryRecovery(recoveredEntry, fileSystem);
      const targetPath = fileSystem?.pathFor(entry.filePath) ?? entry.filePath;
      if (recovery === 'reverse-exchange') {
        await reverseVersion5Publication(recoveredEntry, fileSystem);
        physicalChanged = true;
      } else if (recovery === 'remove-created') {
        const stagedPath = fileSystem?.pathFor(entry.stagedPath!) ?? entry.stagedPath!;
        await retireDesiredGeneration(entry, journal.id, targetPath, stagedPath, fileSystem);
        physicalChanged = true;
      } else if (recovery === 'restore-retired') {
        const retiredPath = fileSystem?.pathFor(entry.retiredPath!) ?? entry.retiredPath!;
        try {
          await fs.link(retiredPath, targetPath);
        } catch (error) {
          if (isAlreadyExistsError(error)) {
            throw new IslandShellFailure(
              'blocked',
              `Tyrian transaction recovery observed a replacement generation at '${entry.filePath}' and left it untouched.`,
              { cause: error, mutation: { externalDrift: true, incompleteRecovery: true } }
            );
          }
          throw error;
        }
        physicalChanged = true;
      }
    } catch (error) {
      failures.push(error);
    }
  }

  try {
    await syncPatchMutationDirectories(
      fileSystem,
      recoveryJournal.entries.map(({ filePath }) => filePath)
    );
  } catch (error) {
    failures.push(error);
  }

  if (failures.length > 0) {
    throw new IslandShellFailure(
      combineIslandFailureCodes(failures),
      `Tyrian transaction recovery could not safely restore every target: ${failures
        .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
        .join(' ')}`,
      {
        cause: new AggregateError(failures),
        mutation: mergeIslandMutationFacts(
          ...failures.map((failure) => readIslandMutationFacts(failure)),
          { physicalChanged, incompleteRecovery: true }
        ),
      }
    );
  }

  if (recoveryJournal.recovery !== undefined) {
    recoveryJournal = await persistVersion5RecoveryAttempt(
      journalPath,
      recoveryJournal,
      { ...recoveryJournal.recovery, phase: 'complete' },
      fileSystem
    );
    await assertVersion5RecoveryComplete(recoveryJournal, fileSystem);
    await removeVersion5RecoveryCandidates(recoveryJournal, fileSystem);
  }
  await removeTemporaryFilesBeforeJournal(journalPath, recoveryJournal, fileSystem);
  return physicalChanged;
}

function version5RecoveryCandidatePath(entry: FileTransactionEntryV5, recoveryId: string): string {
  return transactionSiblingPath(entry.filePath, recoveryId, 'recovery');
}

function version5RecoveryEntry(
  entry: FileTransactionEntryV5,
  recovery: FileTransactionRecoveryAttempt | undefined
): FileTransactionEntryV5 {
  if (entry.publicationPath === undefined) return entry;
  if (recovery === undefined || (recovery.phase !== 'ready' && recovery.phase !== 'complete')) {
    throw new IslandShellFailure(
      'corrupt',
      `Tyrian v5 transaction has no ready recovery source for '${entry.filePath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }
  return { ...entry, publicationPath: version5RecoveryCandidatePath(entry, recovery.id) };
}

async function beginVersion5RecoveryAttempt(
  journalPath: string,
  journal: FileTransactionJournalV5,
  fileSystem?: IslandPatchFileSystem
): Promise<FileTransactionJournalV5> {
  if (fileSystem === undefined) {
    throw new IslandShellFailure(
      'unsupported',
      'Tyrian v5 transaction recovery requires Linux descriptor-anchored fencing.',
      { mutation: { incompleteRecovery: true } }
    );
  }

  let recoveryJournal = journal;
  const previousAttempt = journal.recovery;
  if (previousAttempt?.phase === 'ready') {
    await assertVersion5ReadyAttemptTopology(journal, fileSystem);
    recoveryJournal = await persistVersion5RecoveryAttempt(
      journalPath,
      journal,
      {
        id: crypto.randomUUID(),
        previousId: previousAttempt.id,
        phase: 'fencing',
      },
      fileSystem
    );
  } else if (previousAttempt === undefined) {
    recoveryJournal = await persistVersion5RecoveryAttempt(
      journalPath,
      journal,
      { id: crypto.randomUUID(), phase: 'fencing' },
      fileSystem
    );
  }

  if (recoveryJournal.recovery?.phase !== 'fencing') {
    throw new IslandShellFailure(
      'corrupt',
      `Tyrian v5 transaction has an invalid recovery phase at '${journalPath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }

  await fenceVersion5RecoveryAttempt(recoveryJournal, fileSystem);
  await syncPatchMutationDirectories(
    fileSystem,
    recoveryJournal.entries.map(({ filePath }) => filePath)
  );
  return persistVersion5RecoveryAttempt(
    journalPath,
    recoveryJournal,
    { ...recoveryJournal.recovery, phase: 'ready' },
    fileSystem
  );
}

async function persistVersion5RecoveryAttempt(
  journalPath: string,
  journal: FileTransactionJournalV5,
  recovery: FileTransactionRecoveryAttempt,
  fileSystem?: IslandPatchFileSystem
): Promise<FileTransactionJournalV5> {
  const journalOperationPath = fileSystem?.pathFor(journalPath) ?? journalPath;
  const generation = await readDurableMetadataGeneration(
    journalOperationPath,
    `transaction journal '${journalPath}'`
  );
  if (generation.kind !== 'present' || generation.content !== serializeDurableJson(journal)) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian v5 transaction journal changed before recovery state publication at '${journalPath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  const nextJournal: FileTransactionJournalV5 = { ...journal, recovery };
  await writeDurableJsonFile(journalOperationPath, nextJournal, generation);
  return nextJournal;
}

async function fenceVersion5RecoveryAttempt(
  journal: FileTransactionJournalV5,
  fileSystem: IslandPatchFileSystem
): Promise<void> {
  const recovery = journal.recovery;
  if (recovery?.phase !== 'fencing') {
    throw new IslandShellFailure(
      'corrupt',
      'Tyrian attempted to fence a v5 transaction without a fencing recovery state.',
      { mutation: { incompleteRecovery: true } }
    );
  }

  for (const entry of journal.entries) {
    if (entry.publicationPath === undefined) continue;
    const currentPublicPath = version5RecoveryCandidatePath(entry, recovery.id);
    const priorPublicPath =
      recovery.previousId === undefined
        ? entry.publicationPath
        : version5RecoveryCandidatePath(entry, recovery.previousId);
    const [current, prior] = await Promise.all([
      lstatIfExists(fileSystem.pathFor(currentPublicPath)),
      lstatIfExists(fileSystem.pathFor(priorPublicPath)),
    ]);

    if (current !== undefined && prior !== undefined) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian v5 recovery found competing source generations for '${entry.filePath}' and left both untouched.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    if (current === undefined && prior === undefined) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian v5 recovery lost its fenced source for '${entry.filePath}'.`,
        { mutation: { incompleteRecovery: true } }
      );
    }
    if (current === undefined) {
      // Rename revokes the old helper source before this owner inspects a
      // candidate or plans a target. A delayed exchange now linearizes either
      // before this rename or fails because its source name stays absent.
      await fileSystem.assertNamespaceCurrent();
      await fs.rename(fileSystem.pathFor(priorPublicPath), fileSystem.pathFor(currentPublicPath));
      await fileSystem.assertNamespaceCurrent();
    }

    const [moved, retiredSource, originalSource] = await Promise.all([
      readRegularFileGeneration(
        fileSystem.pathFor(currentPublicPath),
        `v5 fenced recovery source '${currentPublicPath}'`
      ),
      readRegularFileGeneration(
        fileSystem.pathFor(priorPublicPath),
        `v5 revoked recovery source '${priorPublicPath}'`
      ),
      recovery.previousId === undefined
        ? Promise.resolve<RegularFileGeneration>({ kind: 'absent' })
        : readRegularFileGeneration(
            fileSystem.pathFor(entry.publicationPath),
            `revoked publication source '${entry.publicationPath}'`
          ),
    ]);
    if (retiredSource.kind !== 'absent' || originalSource.kind !== 'absent') {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian v5 recovery could not revoke a prior source for '${entry.filePath}'.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    await assertVersion5RecoveryCandidate(entry, moved, currentPublicPath, fileSystem);
  }
}

async function assertVersion5RecoveryCandidate(
  entry: FileTransactionEntryV5,
  generation: RegularFileGeneration,
  displayPath: string,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  if (isOriginalTransactionGeneration(generation, entry)) return;
  if (entry.stagedPath !== undefined && isDesiredTransactionGeneration(generation, entry)) {
    const staged = await readRegularFileGeneration(
      fileSystem?.pathFor(entry.stagedPath) ?? entry.stagedPath,
      `staged transaction generation '${entry.stagedPath}'`
    );
    if (sameRegularFileGeneration(generation, staged)) return;
  }
  throw new IslandShellFailure(
    'blocked',
    `Tyrian v5 recovery source changed at '${displayPath}' and was left untouched.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

/**
 * Ready and complete attempts keep every older publisher name absent. Read
 * again after settlement before cleanup so a prior diagnostic read can never
 * authorize a later mutation.
 */
async function readVersion5RecoveryCandidateAfterRevocation(
  entry: FileTransactionEntryV5,
  recovery: FileTransactionRecoveryAttempt,
  readCandidate: typeof readRegularFileGeneration,
  fileSystem?: IslandPatchFileSystem
): Promise<RegularFileGeneration> {
  if (entry.publicationPath === undefined) return { kind: 'absent' };
  const currentPath = version5RecoveryCandidatePath(entry, recovery.id);
  const revokedPaths = [entry.publicationPath];
  if (recovery.previousId !== undefined) {
    revokedPaths.push(version5RecoveryCandidatePath(entry, recovery.previousId));
  }
  const [current, ...revoked] = await Promise.all([
    readCandidate(
      fileSystem?.pathFor(currentPath) ?? currentPath,
      `v5 recovery source '${currentPath}'`
    ),
    ...revokedPaths.map((candidatePath) =>
      readRegularFileGeneration(
        fileSystem?.pathFor(candidatePath) ?? candidatePath,
        `revoked publication source '${candidatePath}'`
      )
    ),
  ]);
  if (revoked.some((generation) => generation.kind !== 'absent')) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian v5 recovery found a resurrected source for '${entry.filePath}' and left it untouched.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  return current;
}

async function assertVersion5ReadyAttemptTopology(
  journal: FileTransactionJournalV5,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const recovery = journal.recovery;
  if (recovery?.phase !== 'ready') {
    throw new IslandShellFailure('corrupt', 'Tyrian v5 recovery has no ready source topology.', {
      mutation: { incompleteRecovery: true },
    });
  }
  for (const entry of journal.entries) {
    if (entry.publicationPath === undefined) continue;
    const current = await readVersion5RecoveryCandidateAfterRevocation(
      entry,
      recovery,
      readRegularFileGeneration,
      fileSystem
    );
    await assertVersion5RecoveryCandidate(
      entry,
      current,
      version5RecoveryCandidatePath(entry, recovery.id),
      fileSystem
    );
  }
}

/**
 * A fencing record is durable before recovery reads any target. It admits
 * exactly one source per entry: either a prior helper has already exchanged
 * it, or the recovery rename has already revoked it. Doctor only inspects
 * this topology; an owner completes the rename before it plans targets.
 */
async function assertVersion5FencingAttemptTopology(
  journal: FileTransactionJournalV5,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const recovery = journal.recovery;
  if (recovery?.phase !== 'fencing') {
    throw new IslandShellFailure('corrupt', 'Tyrian v5 recovery has no fencing source topology.', {
      mutation: { incompleteRecovery: true },
    });
  }

  for (const entry of journal.entries) {
    if (entry.publicationPath === undefined) continue;
    const currentPath = version5RecoveryCandidatePath(entry, recovery.id);
    const priorPath =
      recovery.previousId === undefined
        ? entry.publicationPath
        : version5RecoveryCandidatePath(entry, recovery.previousId);
    const [current, prior] = await Promise.all([
      readRegularFileGeneration(
        fileSystem?.pathFor(currentPath) ?? currentPath,
        `v5 recovery source '${currentPath}'`
      ),
      readRegularFileGeneration(
        fileSystem?.pathFor(priorPath) ?? priorPath,
        `v5 recovery predecessor '${priorPath}'`
      ),
    ]);
    if (current.kind !== 'absent' && prior.kind !== 'absent') {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian v5 recovery found competing source generations for '${entry.filePath}' and left both untouched.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    if (current.kind === 'absent' && prior.kind === 'absent') {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian v5 recovery lost its fenced source for '${entry.filePath}'.`,
        { mutation: { incompleteRecovery: true } }
      );
    }
    await assertVersion5RecoveryCandidate(
      entry,
      current.kind === 'absent' ? prior : current,
      current.kind === 'absent' ? priorPath : currentPath,
      fileSystem
    );
    if (recovery.previousId !== undefined) {
      const original = await readRegularFileGeneration(
        fileSystem?.pathFor(entry.publicationPath) ?? entry.publicationPath,
        `revoked publication source '${entry.publicationPath}'`
      );
      if (original.kind !== 'absent') {
        throw new IslandShellFailure(
          'blocked',
          `Tyrian v5 recovery found a resurrected publication source at '${entry.publicationPath}'.`,
          { mutation: { externalDrift: true, incompleteRecovery: true } }
        );
      }
    }
  }
}

async function assertVersion5RecoveryComplete(
  journal: FileTransactionJournalV5,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const recovery = journal.recovery;
  if (recovery?.phase !== 'complete') {
    throw new IslandShellFailure('corrupt', 'Tyrian v5 recovery is not marked complete.', {
      mutation: { incompleteRecovery: true },
    });
  }
  for (const entry of journal.entries) {
    const target = await readRegularFileGeneration(
      fileSystem?.pathFor(entry.filePath) ?? entry.filePath,
      `recovered transaction target '${entry.filePath}'`
    );
    if (!isOriginalTransactionGeneration(target, entry)) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian v5 recovery target changed after restoration at '${entry.filePath}'.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    if (entry.publicationPath === undefined) continue;
    const currentPath = version5RecoveryCandidatePath(entry, recovery.id);
    const current = await readVersion5RecoveryCandidateAfterRevocation(
      entry,
      recovery,
      readDurableMetadataGeneration,
      fileSystem
    );
    if (current.kind !== 'absent') {
      await assertVersion5DesiredRecoveryCandidate(entry, current, currentPath, fileSystem);
    }
  }
}

async function assertVersion5DesiredRecoveryCandidate(
  entry: FileTransactionEntryV5,
  generation: RegularFileGeneration,
  displayPath: string,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  if (entry.stagedPath === undefined || !isDesiredTransactionGeneration(generation, entry)) {
    throwUnexpectedTransactionEvidence(displayPath);
  }
  const staged = await readRegularFileGeneration(
    fileSystem?.pathFor(entry.stagedPath) ?? entry.stagedPath,
    `staged transaction generation '${entry.stagedPath}'`
  );
  if (!sameRegularFileGeneration(generation, staged))
    throwUnexpectedTransactionEvidence(displayPath);
}

async function removeVersion5RecoveryCandidates(
  journal: FileTransactionJournalV5,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const recovery = journal.recovery;
  if (recovery?.phase !== 'complete') return;
  for (const entry of journal.entries) {
    if (entry.publicationPath === undefined) continue;
    const sourcePath = version5RecoveryCandidatePath(entry, recovery.id);
    const sourceOperationPath = fileSystem?.pathFor(sourcePath) ?? sourcePath;
    await settleDurableMetadataPublication(
      sourceOperationPath,
      `v5 recovery source '${sourcePath}'`
    );
    const candidate = await readVersion5RecoveryCandidateAfterRevocation(
      entry,
      recovery,
      readRegularFileGeneration,
      fileSystem
    );
    if (candidate.kind === 'absent') continue;
    if (fileSystem === undefined) {
      throw new IslandShellFailure(
        'unsupported',
        `Tyrian v5 recovery cleanup requires Linux filesystem admission for '${entry.filePath}'.`,
        { mutation: { incompleteRecovery: true } }
      );
    }
    await assertVersion5DesiredRecoveryCandidate(entry, candidate, sourcePath, fileSystem);
    await removeFileDurably(sourceOperationPath, { incompleteRecovery: true }, candidate);
  }
}

async function reverseVersion5Publication(
  entry: FileTransactionEntryV5,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  if (
    fileSystem === undefined ||
    entry.publicationPath === undefined ||
    entry.stagedPath === undefined
  ) {
    throw new IslandShellFailure(
      'unsupported',
      `Tyrian v5 transaction recovery requires Linux atomic exchange for '${entry.filePath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }
  await fileSystem.assertNamespaceCurrent();
  exchangeIslandPaths({
    sourceParentDescriptor: fileSystem.parentDescriptorFor(entry.publicationPath),
    sourceLeaf: path.basename(entry.publicationPath),
    targetParentDescriptor: fileSystem.parentDescriptorFor(entry.filePath),
    targetLeaf: path.basename(entry.filePath),
  });
  await fileSystem.assertNamespaceCurrent();
  const [target, publication, staged] = await Promise.all([
    readRegularFileGeneration(
      fileSystem.pathFor(entry.filePath),
      `restored transaction target '${entry.filePath}'`
    ),
    readRegularFileGeneration(
      fileSystem.pathFor(entry.publicationPath),
      `publication candidate '${entry.publicationPath}'`
    ),
    readRegularFileGeneration(
      fileSystem.pathFor(entry.stagedPath),
      `staged transaction generation '${entry.stagedPath}'`
    ),
  ]);
  if (
    !isOriginalTransactionGeneration(target, entry) ||
    !sameRegularFileGeneration(publication, staged)
  ) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian v5 transaction changed across atomic recovery at '${entry.filePath}' and preserved every generation.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
}

async function retireDesiredGeneration(
  entry: FileTransactionEntry,
  transactionId: string,
  targetPath: string,
  stagedPath: string,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const rollbackPublicPath = transactionSiblingPath(entry.filePath, transactionId, 'rollback');
  const rollbackPath = fileSystem?.pathFor(rollbackPublicPath) ?? rollbackPublicPath;
  await fs.rename(targetPath, rollbackPath);
  const [movedStats, stagedStats] = await Promise.all([
    fs.lstat(rollbackPath),
    fs.lstat(stagedPath),
  ]);
  if (movedStats.dev !== stagedStats.dev || movedStats.ino !== stagedStats.ino) {
    await restoreRetiredGeneration(rollbackPath, targetPath);
    throw new IslandShellFailure(
      'blocked',
      `Tyrian transaction target changed across the recovery retirement boundary at '${entry.filePath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  await fs.unlink(rollbackPath);
}

async function readTransactionTarget(
  filePath: string,
  displayPath = filePath
): Promise<string | undefined> {
  const stats = await lstatIfExists(filePath);

  if (stats === undefined) return undefined;
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian transaction target generation is not a regular file at '${displayPath}'.`
    );
  }

  return fs.readFile(filePath, 'utf8');
}

function checksumOrNull(content: string | undefined): string | null {
  return content === undefined ? null : sha256Base64(content);
}

async function inspectFileTransactionCleanup(
  journal: FileTransactionJournal,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  for (const entry of journal.entries) {
    for (const { kind, temporaryPath } of transactionTemporaryPaths(journal, entry)) {
      await inspectOwnedTransactionTemporary(
        transactionCleanupOperationPath(entry.filePath, temporaryPath, fileSystem),
        temporaryPath,
        journal,
        entry,
        kind,
        'inspect'
      );
    }
  }
}

async function removeTemporaryFilesBeforeJournal(
  journalPath: string,
  journal: FileTransactionJournal,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const temporaryDirectories = new Set<string>();

  for (const entry of journal.entries) {
    for (const { kind, temporaryPath } of transactionTemporaryPaths(journal, entry)) {
      const operationPath = transactionCleanupOperationPath(
        entry.filePath,
        temporaryPath,
        fileSystem
      );
      await removeOwnedTransactionTemporary(operationPath, temporaryPath, journal, entry, kind);
      temporaryDirectories.add(path.dirname(temporaryPath));
    }
  }

  const patchDirectories = [...temporaryDirectories].filter(
    (directory) =>
      fileSystem === undefined ||
      directory === fileSystem.appRoot ||
      directory === fileSystem.paths.workbenchDirPath
  );
  await syncPatchMutationDirectories(
    fileSystem,
    patchDirectories.map((directory) => path.join(directory, '.'))
  );
  const journalOperationPath = fileSystem?.pathFor(journalPath) ?? journalPath;
  const journalGeneration = await settleDurableMetadataPublication(
    journalOperationPath,
    `transaction journal '${journalPath}'`
  );
  if (
    journalGeneration.kind === 'present' &&
    checksumOrNull(journalGeneration.content) !== sha256Base64(serializeDurableJson(journal))
  ) {
    throwUnexpectedTransactionEvidence(journalPath);
  }
  await removeFileDurably(journalOperationPath, { incompleteRecovery: true }, journalGeneration);
}

function transactionCleanupOperationPath(
  targetPath: string,
  temporaryPath: string,
  fileSystem: IslandPatchFileSystem | undefined
): string {
  if (fileSystem === undefined) return temporaryPath;
  const targetParent = path.dirname(targetPath);
  const belongsToPatchSession =
    targetParent === fileSystem.appRoot || targetParent === fileSystem.paths.workbenchDirPath;
  if (belongsToPatchSession) return fileSystem.pathFor(temporaryPath);
  throw new IslandShellFailure(
    'corrupt',
    `Tyrian transaction cleanup target escapes its admitted filesystem at '${targetPath}'.`,
    { mutation: { incompleteRecovery: true } }
  );
}

type TransactionTemporaryKind = 'stage' | 'backup' | 'retired' | 'publication' | 'rollback';

type TransactionTemporaryPolicy = 'disposable' | 'sealed' | 'impossible';

function transactionTemporaryPaths(
  journal: FileTransactionJournal,
  entry: FileTransactionEntry
): Array<{ kind: TransactionTemporaryKind; temporaryPath: string }> {
  const paths: Array<{ kind: TransactionTemporaryKind; temporaryPath: string }> = [];

  if (journal.version === 4) {
    paths.push({ kind: 'retired', temporaryPath: (entry as FileTransactionEntryV4).retiredPath });
  } else {
    const version5Entry = entry as FileTransactionEntryV5;
    // A prepared v5 publication is a hardlink to stage. Dispose it while
    // stage still exists so the proof survives recovery cleanup.
    if (version5Entry.publicationPath !== undefined) {
      paths.push({ kind: 'publication', temporaryPath: version5Entry.publicationPath });
    }
    if (version5Entry.retiredPath !== undefined) {
      paths.push({ kind: 'retired', temporaryPath: version5Entry.retiredPath });
    }
  }

  paths.push({
    kind: 'rollback',
    temporaryPath: transactionSiblingPath(entry.filePath, journal.id, 'rollback'),
  });
  if (entry.backupPath !== undefined) {
    paths.push({ kind: 'backup', temporaryPath: entry.backupPath });
  }
  if (entry.stagedPath !== undefined) {
    paths.push({ kind: 'stage', temporaryPath: entry.stagedPath });
  }

  return paths;
}

async function removeOwnedTransactionTemporary(
  operationPath: string,
  displayPath: string,
  journal: FileTransactionJournal,
  entry: FileTransactionEntry,
  kind: TransactionTemporaryKind
): Promise<void> {
  await settleDurableMetadataPublication(
    operationPath,
    `transaction cleanup evidence '${displayPath}'`
  );
  const generation = await inspectOwnedTransactionTemporary(
    operationPath,
    displayPath,
    journal,
    entry,
    kind,
    'remove'
  );
  if (generation.kind !== 'absent') {
    await removeFileDurably(operationPath, { incompleteRecovery: true }, generation);
  }
}

async function inspectOwnedTransactionTemporary(
  operationPath: string,
  displayPath: string,
  journal: FileTransactionJournal,
  entry: FileTransactionEntry,
  kind: TransactionTemporaryKind,
  purpose: 'inspect' | 'remove'
): Promise<RegularFileGeneration> {
  const generation = await readDurableMetadataGeneration(
    operationPath,
    `transaction cleanup evidence '${displayPath}'`
  );
  if (generation.kind === 'absent') return generation;

  const policy = transactionTemporaryPolicy(journal, kind);
  if (policy === 'disposable') return generation;
  if (policy === 'impossible') {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian transaction found impossible ${kind} evidence while its preparing phase owns no target mutation at '${displayPath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }

  if (journal.version === 5 && kind === 'publication') {
    const version5Entry = entry as FileTransactionEntryV5;
    const expectsOriginal =
      journal.phase === 'verified' ||
      (purpose === 'inspect' &&
        journal.phase === 'committing' &&
        isOriginalTransactionGeneration(generation, version5Entry));
    if (expectsOriginal) {
      if (!isOriginalTransactionGeneration(generation, version5Entry)) {
        throwUnexpectedTransactionEvidence(displayPath);
      }
      return generation;
    }
    if (
      !isDesiredTransactionGeneration(generation, version5Entry) ||
      version5Entry.stagedPath === undefined
    ) {
      throwUnexpectedTransactionEvidence(displayPath);
    }
    const staged = await readDurableMetadataGeneration(
      path.join(path.dirname(operationPath), path.basename(version5Entry.stagedPath)),
      `staged transaction generation '${version5Entry.stagedPath}'`
    );
    if (!sameRegularFileGeneration(generation, staged))
      throwUnexpectedTransactionEvidence(displayPath);
    return generation;
  }

  const expectedChecksum =
    kind === 'stage' || kind === 'rollback' ? entry.desiredChecksum : entry.originalChecksum;
  if (checksumOrNull(generation.content) !== expectedChecksum) {
    throwUnexpectedTransactionEvidence(displayPath);
  }
  if (kind === 'retired' && !isOriginalTransactionGeneration(generation, entry)) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian transaction cleanup found a replacement retired generation at '${displayPath}' and left it untouched.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  return generation;
}

/**
 * A preparing journal is durable before any target mutation. Its UUID-named
 * staging files may therefore be incomplete if the writer died mid-write and
 * are disposable. Once prepared is durable, each artifact becomes evidence
 * that must still match the sealed transaction generation.
 */
function transactionTemporaryPolicy(
  journal: FileTransactionJournal,
  kind: TransactionTemporaryKind
): TransactionTemporaryPolicy {
  if (journal.phase !== 'preparing') return 'sealed';
  if (kind === 'retired' || kind === 'rollback') return 'impossible';
  return 'disposable';
}

function throwUnexpectedTransactionEvidence(displayPath: string): never {
  throw new IslandShellFailure(
    'blocked',
    `Tyrian transaction cleanup found replacement evidence at '${displayPath}' and left it untouched.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

function transactionSiblingPath(
  filePath: string,
  transactionId: string,
  kind: 'backup' | 'stage' | 'restore' | 'retired' | 'publication' | 'recovery' | 'rollback'
): string {
  return path.join(
    path.dirname(filePath),
    `.tyrian-night-${transactionId}-${kind}-${path.basename(filePath)}.tmp`
  );
}

async function recoverRootFileTransactions(
  appRoot: string,
  fileSystem?: IslandPatchFileSystem
): Promise<boolean> {
  return recoverFileTransaction(
    islandTransactionJournalPath(appRoot),
    islandTransactionAllowedTargets(appRoot),
    appRoot,
    fileSystem
  );
}

function islandOwnedFilePaths(appRoot: string): readonly string[] {
  const paths = buildIslandPatchPaths(path.resolve(appRoot));
  return [
    paths.workbenchHtmlPath,
    paths.productJsonPath,
    paths.islandCssPath,
    paths.manifestPath,
    paths.backupHtmlPath,
    paths.backupProductJsonPath,
    paths.transactionJournalPath,
  ];
}

function islandTransactionAllowedTargets(appRoot: string): Set<string> {
  return new Set(islandOwnedFilePaths(appRoot).slice(0, -1));
}

function islandTransactionJournalPath(appRoot: string): string {
  return islandOwnedFilePaths(appRoot)[6]!;
}

/** Validate the visible Island namespace before an unanchored read or admission. */
async function assertPatchPathAncestorsOwned(appRoot: string): Promise<void> {
  const targetPaths = islandOwnedFilePaths(appRoot);
  await assertIslandPatchAncestorsOwned(appRoot);

  for (const targetPath of targetPaths) {
    const stats = await lstatIfExists(targetPath);
    if (stats !== undefined && (!stats.isFile() || stats.isSymbolicLink())) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian patch target is not an owned regular file at '${targetPath}'.`
      );
    }
  }
}

async function assertIslandPatchAncestorsOwned(appRoot: string): Promise<void> {
  const canonicalAppRoot = path.resolve(appRoot);
  const targetPaths = islandOwnedFilePaths(canonicalAppRoot);
  const ancestors = new Set<string>();

  for (const targetPath of targetPaths) {
    let ancestor = path.dirname(targetPath);
    while (ancestor !== canonicalAppRoot) {
      const relative = path.relative(canonicalAppRoot, ancestor);
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw new IslandShellFailure(
          'blocked',
          `Tyrian patch target escapes the canonical app root at '${targetPath}'.`
        );
      }
      ancestors.add(ancestor);
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }

  const orderedAncestors = [...ancestors].sort(
    (left, right) => left.split(path.sep).length - right.split(path.sep).length
  );

  for (const ancestor of orderedAncestors) {
    const stats = await lstatIfExists(ancestor);
    if (stats === undefined) continue;
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian patch ancestor is not an owned regular directory at '${ancestor}'.`
      );
    }
  }
}

async function recoverFileTransaction(
  journalPath: string,
  allowedTargets: Set<string>,
  appRoot: string,
  fileSystem?: IslandPatchFileSystem
): Promise<boolean> {
  const journalOperationPath = fileSystem?.pathFor(journalPath) ?? journalPath;
  const journalGeneration = await settleDurableMetadataPublication(
    journalOperationPath,
    `transaction journal '${journalPath}'`
  );
  if (journalGeneration.kind === 'absent') {
    return false;
  }
  const content = journalGeneration.content;

  let journal: FileTransactionJournal;
  try {
    journal = parseFileTransactionJournal(content, journalPath, allowedTargets, appRoot);
  } catch (error) {
    throw new IslandShellFailure(
      'corrupt',
      error instanceof Error ? error.message : String(error),
      { cause: error, mutation: { incompleteRecovery: true } }
    );
  }

  if (journal.phase === 'verified') {
    await removeTemporaryFilesBeforeJournal(journalPath, journal, fileSystem);
    return false;
  }

  return rollbackFileTransaction(journalPath, journal, fileSystem);
}

async function inspectIslandTransactionHealth(
  journalPath: string,
  appRoot: string,
  fileSystem?: IslandPatchFileSystem
): Promise<IslandTransactionHealth> {
  const journalOperationPath = fileSystem?.pathFor(journalPath) ?? journalPath;
  let journalGeneration: RegularFileGeneration;
  let journal: FileTransactionJournal;
  try {
    journalGeneration = await readDurableMetadataGeneration(
      journalOperationPath,
      `transaction journal '${journalPath}'`
    );
    if (journalGeneration.kind === 'absent') return { kind: 'clean', recoverability: 'none' };
    journal = parseFileTransactionJournal(
      journalGeneration.content,
      journalPath,
      islandTransactionAllowedTargets(appRoot),
      appRoot
    );
  } catch (error) {
    if (isPermissionError(error)) throw error;
    return {
      kind: 'corrupt',
      recoverability: 'manual',
      journalPath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    if (journal.phase === 'committing') {
      if (journal.version === 5 && journal.recovery !== undefined) {
        await inspectVersion5RecoveryAttempt(journal, fileSystem);
      } else {
        for (const entry of journal.entries) {
          await planFileTransactionEntryRecovery(journal.version, entry, fileSystem);
        }
      }
    }
    await inspectFileTransactionCleanup(journal, fileSystem);
  } catch (error) {
    if (isPermissionError(error)) throw error;
    const failure = describeIslandShellFailure(error);
    return {
      kind: failure.code === 'blocked' ? 'external-drift' : 'corrupt',
      recoverability: 'manual',
      journalPath,
      reason: failure.reason,
    };
  }

  return {
    kind: 'recoverable',
    recoverability: 'automatic',
    journalPath,
    version: journal.version,
    phase: journal.phase,
    reason: `Tyrian transaction journal is pending automatic ${journal.phase === 'verified' ? 'cleanup' : 'recovery'} at '${journalPath}'.`,
  };
}

/**
 * Read-only Doctor never revokes a publication source. A fencing record is
 * therefore advisory until a lock owner resumes it, while a ready record has
 * already revoked every helper source and can safely plan target recovery.
 */
async function inspectVersion5RecoveryAttempt(
  journal: FileTransactionJournalV5,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const recovery = journal.recovery;
  if (recovery === undefined) return;
  if (recovery.phase === 'fencing') {
    await assertVersion5FencingAttemptTopology(journal, fileSystem);
    return;
  }
  if (recovery.phase === 'ready') {
    await assertVersion5ReadyAttemptTopology(journal, fileSystem);
    for (const entry of journal.entries) {
      await planVersion5FileTransactionEntryRecovery(
        version5RecoveryEntry(entry, recovery),
        fileSystem
      );
    }
    return;
  }
  await assertVersion5RecoveryComplete(journal, fileSystem);
}

async function tryReadFileTransactionJournal(
  journalPath: string,
  allowedTargets: ReadonlySet<string>,
  appRoot: string,
  fileSystem?: IslandPatchFileSystem
): Promise<FileTransactionJournal | undefined> {
  const journalOperationPath = fileSystem?.pathFor(journalPath) ?? journalPath;
  const generation = await settleDurableMetadataPublication(
    journalOperationPath,
    `transaction journal '${journalPath}'`
  );
  if (generation.kind === 'absent') {
    return undefined;
  }

  try {
    return parseFileTransactionJournal(generation.content, journalPath, allowedTargets, appRoot);
  } catch (error) {
    throw new IslandShellFailure(
      'corrupt',
      error instanceof Error ? error.message : String(error),
      { cause: error, mutation: { incompleteRecovery: true } }
    );
  }
}

function parseFileTransactionJournal(
  content: string,
  journalPath: string,
  allowedTargets: ReadonlySet<string>,
  expectedAppRoot?: string
): FileTransactionJournal {
  let parsed: Record<string, unknown>;

  try {
    const value: unknown = JSON.parse(content);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('not an object');
    }
    parsed = value as Record<string, unknown>;
  } catch {
    throw new Error(`Tyrian file transaction journal is invalid JSON at '${journalPath}'.`);
  }

  if (
    (parsed.version !== 4 && parsed.version !== 5) ||
    typeof parsed.id !== 'string' ||
    !/^[0-9a-f-]{36}$/iu.test(parsed.id) ||
    typeof parsed.phase !== 'string' ||
    !['preparing', 'prepared', 'committing', 'verified'].includes(parsed.phase) ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length === 0
  ) {
    throw new Error(`Tyrian file transaction journal is invalid at '${journalPath}'.`);
  }
  if (
    parsed.version === 5 &&
    !isValidVersion5RecoveryAttempt(
      parsed.recovery,
      parsed.phase as FileTransactionJournal['phase']
    )
  ) {
    throw new Error(
      `Tyrian file transaction journal has invalid recovery state at '${journalPath}'.`
    );
  }

  if (
    typeof parsed.appRoot !== 'string' ||
    !path.isAbsolute(parsed.appRoot) ||
    parsed.appRoot !== path.resolve(parsed.appRoot) ||
    (expectedAppRoot !== undefined && parsed.appRoot !== expectedAppRoot)
  ) {
    throw new Error(`Tyrian file transaction journal has an invalid app root at '${journalPath}'.`);
  }

  const targets = new Set<string>();
  for (const entry of parsed.entries) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry) ||
      !isValidTransactionEntryCommon(entry, parsed.id, allowedTargets, targets)
    ) {
      throw new Error(
        `Tyrian file transaction journal contains an invalid entry at '${journalPath}'.`
      );
    }

    const record = entry as Record<string, unknown>;
    const validVersionSpecificEntry =
      parsed.version === 4
        ? isValidVersion4TransactionEntry(record, parsed.id)
        : isValidVersion5TransactionEntry(record, parsed.id);
    if (!validVersionSpecificEntry) {
      throw new Error(
        `Tyrian file transaction journal contains an invalid entry at '${journalPath}'.`
      );
    }

    targets.add(record.filePath as string);
  }

  return parsed as FileTransactionJournal;
}

function isValidTransactionEntryCommon(
  entry: object,
  transactionId: string,
  allowedTargets: ReadonlySet<string>,
  targets: ReadonlySet<string>
): boolean {
  const record = entry as Record<string, unknown>;
  const filePath = record.filePath;
  const backupPath = record.backupPath;
  const stagedPath = record.stagedPath;
  const originalChecksum = record.originalChecksum;
  const desiredChecksum = record.desiredChecksum;
  if (
    typeof filePath !== 'string' ||
    typeof backupPath !== 'string' ||
    (stagedPath !== undefined && typeof stagedPath !== 'string') ||
    typeof record.existed !== 'boolean' ||
    !isTransactionChecksum(originalChecksum) ||
    !isTransactionChecksum(desiredChecksum) ||
    !path.isAbsolute(filePath) ||
    targets.has(filePath) ||
    !allowedTargets.has(filePath) ||
    backupPath !== transactionSiblingPath(filePath, transactionId, 'backup') ||
    (stagedPath !== undefined &&
      stagedPath !== transactionSiblingPath(filePath, transactionId, 'stage'))
  ) {
    return false;
  }
  if (record.existed) {
    return (
      Number.isInteger(record.originalMode) &&
      typeof record.originalDevice === 'string' &&
      /^\d+$/u.test(record.originalDevice) &&
      typeof record.originalInode === 'string' &&
      /^\d+$/u.test(record.originalInode)
    );
  }
  return (
    record.originalMode === undefined &&
    record.originalDevice === undefined &&
    record.originalInode === undefined
  );
}

function isTransactionChecksum(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[A-Za-z0-9+/]+$/u.test(value));
}

function isValidVersion4TransactionEntry(
  entry: Record<string, unknown>,
  transactionId: string
): boolean {
  return (
    typeof entry.filePath === 'string' &&
    typeof entry.retiredPath === 'string' &&
    entry.retiredPath === transactionSiblingPath(entry.filePath, transactionId, 'retired') &&
    entry.publicationPath === undefined
  );
}

function isValidVersion5TransactionEntry(
  entry: Record<string, unknown>,
  transactionId: string
): boolean {
  if (typeof entry.filePath !== 'string' || typeof entry.existed !== 'boolean') return false;
  const desired = entry.desiredChecksum;
  const hasDesired = typeof desired === 'string';
  const stagedPath = entry.stagedPath;
  const publicationPath = entry.publicationPath;
  const retiredPath = entry.retiredPath;
  if (
    (hasDesired &&
      (typeof stagedPath !== 'string' ||
        stagedPath !== transactionSiblingPath(entry.filePath, transactionId, 'stage'))) ||
    (!hasDesired && stagedPath !== undefined) ||
    (!entry.existed && !hasDesired)
  ) {
    return false;
  }

  const requiresPublication = entry.existed && hasDesired;
  if (
    (requiresPublication &&
      (typeof publicationPath !== 'string' ||
        publicationPath !==
          transactionSiblingPath(entry.filePath, transactionId, 'publication'))) ||
    (!requiresPublication && publicationPath !== undefined)
  ) {
    return false;
  }

  const requiresRetired = entry.existed && !hasDesired;
  return (
    (requiresRetired &&
      typeof retiredPath === 'string' &&
      retiredPath === transactionSiblingPath(entry.filePath, transactionId, 'retired')) ||
    (!requiresRetired && retiredPath === undefined)
  );
}

function isValidVersion5RecoveryAttempt(
  value: unknown,
  transactionPhase: FileTransactionJournal['phase']
): boolean {
  if (value === undefined) return true;
  if (transactionPhase !== 'committing') return false;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const attempt = value as Record<string, unknown>;
  return (
    typeof attempt.id === 'string' &&
    /^[0-9a-f-]{36}$/iu.test(attempt.id) &&
    (attempt.previousId === undefined ||
      (typeof attempt.previousId === 'string' && /^[0-9a-f-]{36}$/iu.test(attempt.previousId))) &&
    attempt.previousId !== attempt.id &&
    (attempt.phase === 'fencing' || attempt.phase === 'ready' || attempt.phase === 'complete')
  );
}
