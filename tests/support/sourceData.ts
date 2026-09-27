import fs from 'node:fs';

import { loadSourceModule } from '../../scripts/sourceModule.mjs';

/** Reads a typed source data module (source/*.cjs, scripts/projections/*.cjs). */
export function readSourceData<T = any>(filePath: string): T {
  return loadSourceModule(filePath) as T;
}

/** Writes a source data module fixture; type annotations are not needed at runtime. */
export function writeSourceData(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `module.exports = ${JSON.stringify(value)};\n`);
}
