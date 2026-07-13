export class IslandRegistryQuarantineError extends Error {
  readonly changed = true;
  readonly desiredStateChanged = false;
  readonly registryChanged = true;
  readonly physicalChanged = false;
  readonly externalDrift = false;
  readonly incompleteRecovery = true;
  readonly quarantinePath: string;

  constructor(quarantinePath: string, cause: unknown) {
    super(
      `Tyrian quarantined a managed-root record at '${quarantinePath}', but directory durability sync failed.`,
      { cause }
    );
    this.name = 'IslandRegistryQuarantineError';
    this.quarantinePath = quarantinePath;
  }
}

export async function moveRegistryRecordToQuarantineCore(options: {
  recordPath: string;
  recordDirectory: string;
  quarantinePath: string;
  quarantineDirectory: string;
  rename: (sourcePath: string, targetPath: string) => Promise<void>;
  syncDirectories: (directoryPaths: string[]) => Promise<void>;
}): Promise<void> {
  await options.rename(options.recordPath, options.quarantinePath);
  try {
    await options.syncDirectories([options.recordDirectory, options.quarantineDirectory]);
  } catch (error) {
    throw new IslandRegistryQuarantineError(options.quarantinePath, error);
  }
}
