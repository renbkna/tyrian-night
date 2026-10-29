import { runUnderIslandLock } from './islandLock.js';
import { describeIslandShellFailure } from './islandShellContract.js';
import {
  applyIslandUiSupervised,
  convergeIslandUiSupervised,
  readIslandUiSupervisorStatuses,
  restoreIslandUiSupervised,
} from './islandSupervisor.js';
import {
  decodeIslandCliInvocation,
  type IslandCliCommand,
  type IslandCliInputs,
  type IslandCliInvocation,
  type IslandCliResults,
} from './islandWire.js';

/** Each command and whether it mutates; mutating commands run under the Island lock. */
const COMMANDS: {
  [Command in IslandCliCommand]: {
    mutates: boolean;
    run: (input: IslandCliInputs[Command]) => Promise<IslandCliResults[Command]>;
  };
} = {
  'apply-supervised': { mutates: true, run: applyIslandUiSupervised },
  converge: { mutates: true, run: convergeIslandUiSupervised },
  'restore-supervised': { mutates: true, run: restoreIslandUiSupervised },
  'status-all-supervised': { mutates: false, run: readIslandUiSupervisorStatuses },
};

async function main(): Promise<void> {
  // Decoding rejects bad arguments before the lock is taken.
  const { command, input } = decodeIslandCliInvocation(process.argv.slice(2));
  const { mutates, run } = COMMANDS[command] as {
    mutates: boolean;
    run: (input: IslandCliInvocation['input']) => Promise<unknown>;
  };
  const execute = async () => {
    process.stdout.write(JSON.stringify(await run(input)));
  };
  await (mutates ? runUnderIslandLock(execute) : execute());
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${JSON.stringify(describeIslandShellFailure(error))}\n`);
  process.exitCode = 1;
}
