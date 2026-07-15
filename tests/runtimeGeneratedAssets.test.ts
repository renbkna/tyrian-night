import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test } from 'bun:test';

test('runtime generator entrypoints resolve the repository independently of cwd', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-runtime-generator-cwd-'));

  try {
    for (const script of ['scripts/terminalThemes.mjs', 'scripts/desktopThemes.mjs']) {
      execFileSync('node', [path.resolve(script), '--check'], { cwd, stdio: 'pipe' });
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
