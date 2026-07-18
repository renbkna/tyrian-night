const browserRuntimePattern = /browser-runtime/giu;
const runtimeChannel = 'browser-runtime-channel';
const missingRuntimeValue = null;
const runtimeEnabled = true;

export function acceptsRuntime(value: string | null): boolean {
  return value !== missingRuntimeValue && browserRuntimePattern.test(`${runtimeChannel}:${value}`);
}
