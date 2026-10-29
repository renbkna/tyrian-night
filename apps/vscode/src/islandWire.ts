import { parseArgs } from 'node:util';

import type { IslandShellEnvironment } from './islandPatchContract.js';
import type {
  applyIslandUiSupervised,
  convergeIslandUiSupervised,
  IslandUiApplySupervisionResult,
  IslandUiConvergeResult,
  IslandUiRestoreSupervisionResult,
  IslandUiSupervisorInventory,
  readIslandUiSupervisorStatuses,
  restoreIslandUiSupervised,
} from './islandSupervisor.js';

/**
 * The Island CLI commands and the JSON each writes to stdout on success. The
 * extension only spawns the CLI bundled in the same build, so this module is
 * the whole wire contract; failures write an `IslandShellFailureDescription`
 * line to stderr and exit nonzero.
 */
export type IslandCliResults = {
  'apply-supervised': IslandUiApplySupervisionResult;
  converge: IslandUiConvergeResult;
  'restore-supervised': IslandUiRestoreSupervisionResult;
  'status-all-supervised': IslandUiSupervisorInventory;
};

export type IslandCliCommand = keyof IslandCliResults;

/** A supervisor operation's options without the test-only registry seam. */
type SupervisorInput<Operation extends (options: never) => unknown> = Omit<
  NonNullable<Parameters<Operation>[0]>,
  keyof IslandShellEnvironment
>;

/** What each command acts on: the options of the supervisor operation it runs. */
export type IslandCliInputs = {
  'apply-supervised': SupervisorInput<typeof applyIslandUiSupervised>;
  converge: SupervisorInput<typeof convergeIslandUiSupervised>;
  'restore-supervised': SupervisorInput<typeof restoreIslandUiSupervised>;
  'status-all-supervised': SupervisorInput<typeof readIslandUiSupervisorStatuses>;
};

export type IslandCliInvocation = {
  [Command in IslandCliCommand]: { command: Command; input: IslandCliInputs[Command] };
}[IslandCliCommand];

type WireOptions = Record<
  string,
  { type: 'string'; multiple?: boolean } | { type: 'boolean'; multiple?: never }
>;
type WireValues<Options extends WireOptions> = {
  [Name in keyof Options]?: Options[Name] extends { type: 'boolean' }
    ? boolean
    : Options[Name] extends { multiple: true }
      ? string[]
      : string;
};
type CommandWire<Input, Options extends WireOptions> = {
  options: Options;
  encode(input: Input): WireValues<Options>;
  decode(values: WireValues<Options>): Input;
};

function commandWire<Input>() {
  return <const Options extends WireOptions>(wire: CommandWire<Input, Options>) => wire;
}

const APP_ROOTS_WIRE = commandWire<IslandCliInputs['restore-supervised']>()({
  options: { 'app-root': { type: 'string', multiple: true } },
  encode: (input) => ({ 'app-root': input.preferredAppRoots }),
  decode: (values) => {
    const preferredAppRoots = values['app-root'] ?? [];
    if (preferredAppRoots.some((appRoot) => !appRoot)) {
      throw new Error("Argument '--app-root' must not be empty.");
    }
    return { preferredAppRoots };
  },
});

/** Each command's options, parsed strictly, and how its input maps onto them. */
const ISLAND_CLI_WIRE = {
  'apply-supervised': commandWire<IslandCliInputs['apply-supervised']>()({
    options: {
      'app-root': { type: 'string' },
      'css-source': { type: 'string' },
      'theme-version': { type: 'string' },
    },
    encode: (input) => ({
      'app-root': input.appRoot,
      'css-source': input.cssSourcePath,
      'theme-version': input.themeVersion,
    }),
    decode: (values) => ({
      appRoot: requireValue(values, 'app-root'),
      cssSourcePath: requireValue(values, 'css-source'),
      themeVersion: requireValue(values, 'theme-version'),
    }),
  }),
  converge: commandWire<IslandCliInputs['converge']>()({
    options: {
      'app-root': { type: 'string' },
      'island-dir': { type: 'string' },
      'theme-version': { type: 'string' },
      repair: { type: 'boolean' },
      'fallback-css': { type: 'string' },
    },
    encode: (input) => ({
      'app-root': input.appRoot,
      'island-dir': input.islandDirectory,
      'theme-version': input.themeVersion,
      ...(input.intent.kind === 'repair'
        ? { repair: true, 'fallback-css': input.intent.fallbackCssFile }
        : {}),
    }),
    decode: (values) => {
      if (!values.repair && values['fallback-css'] !== undefined) {
        throw new Error("Argument '--fallback-css' requires '--repair'.");
      }
      return {
        appRoot: requireValue(values, 'app-root'),
        islandDirectory: requireValue(values, 'island-dir'),
        themeVersion: requireValue(values, 'theme-version'),
        intent: values.repair
          ? { kind: 'repair', fallbackCssFile: values['fallback-css'] }
          : { kind: 'startup' },
      };
    },
  }),
  'restore-supervised': APP_ROOTS_WIRE,
  'status-all-supervised': APP_ROOTS_WIRE,
} satisfies { [Command in IslandCliCommand]: CommandWire<IslandCliInputs[Command], WireOptions> };

type WireValue = string | string[] | boolean | undefined;
/**
 * `satisfies` above pairs each command's input with its own options; a lookup
 * by a runtime command name sees that pairing erased.
 */
const ERASED_WIRE = ISLAND_CLI_WIRE as unknown as Record<
  IslandCliCommand,
  {
    options: WireOptions;
    encode(input: unknown): Record<string, WireValue>;
    decode(values: ReturnType<typeof parseArgs>['values']): unknown;
  }
>;

/** The CLI arguments for one command: its name, then the options that carry `input`. */
export function encodeIslandCliInvocation<Command extends IslandCliCommand>(
  command: Command,
  input: IslandCliInputs[Command]
): string[] {
  return [
    command,
    ...Object.entries(ERASED_WIRE[command].encode(input)).flatMap(([name, value]) =>
      value === undefined || value === false
        ? []
        : value === true
          ? [`--${name}`]
          : (Array.isArray(value) ? value : [value]).flatMap((item) => [`--${name}`, item])
    ),
  ];
}

export function decodeIslandCliInvocation(argv: readonly string[]): IslandCliInvocation {
  const [command, ...args] = argv;
  if (command === undefined || !Object.hasOwn(ISLAND_CLI_WIRE, command)) {
    throw new Error(
      `Unknown Tyrian Night CLI command. Use ${Object.keys(ISLAND_CLI_WIRE)
        .map((name) => `'${name}'`)
        .join(', ')}.`
    );
  }
  const wire = ERASED_WIRE[command as IslandCliCommand];
  const { values } = parseArgs({ args, options: wire.options, strict: true });
  return { command, input: wire.decode(values) } as IslandCliInvocation;
}

function requireValue<Name extends string>(values: { [Key in Name]?: string }, name: Name): string {
  const value = values[name];
  if (!value) throw new Error(`Missing required argument '--${name}'.`);
  return value;
}
