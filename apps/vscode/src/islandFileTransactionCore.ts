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

export async function rollbackFailedFileTransactionCore(options: {
  transactionError: unknown;
  physicalMutationAttempted: boolean;
  rollback: () => Promise<void>;
}): Promise<never> {
  try {
    await options.rollback();
  } catch (rollbackError) {
    if (options.physicalMutationAttempted) {
      throw new IslandFileTransactionPartialMutationError(options.transactionError, rollbackError);
    }
    throw new AggregateError(
      [options.transactionError, rollbackError],
      'Tyrian file transaction and rollback both failed'
    );
  }
  throw options.transactionError;
}
