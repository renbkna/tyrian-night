import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';

import { holdPipeLock } from '../../apps/vscode/src/islandLock.js';
import {
  WORKBENCH_CHECKSUM_KEY,
  WORKBENCH_CSS_LINK,
  buildIslandPatchPaths,
} from '../../apps/vscode/src/islandPatchContract.js';

// These tests run on every CI operating system: they execute the bundled CLI
// under Node, the way the extension runs it, with that platform's Island lock.
setDefaultTimeout(60_000);

let root: string;
let cliPath: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-island-portable-'));
  const build = await Bun.build({
    entrypoints: [path.resolve('apps/vscode/src/islandCli.ts')],
    outdir: path.join(root, 'bundle'),
    target: 'node',
    format: 'esm',
    naming: '[name].mjs',
  });
  if (!build.success) throw new AggregateError(build.logs, 'Island CLI bundle failed');
  cliPath = path.join(root, 'bundle', 'islandCli.mjs');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('the bundled CLI applies and restores Island UI', async () => {
  const home = makeHome('round-trip');
  const appRoot = makeAppRoot('round-trip');
  const cssSource = writeCss('round-trip.css', 'teal');

  const applied = await runCli(home, [
    'apply-supervised',
    '--app-root',
    appRoot,
    '--css-source',
    cssSource,
    '--theme-version',
    'test',
  ]);
  expect(applied).toMatchObject({ kind: 'applied', status: { classification: 'patched' } });
  expect(fs.readFileSync(buildIslandPatchPaths(appRoot).workbenchHtmlPath, 'utf8')).toContain(
    'tyrian-night.island.css'
  );

  const restored = await runCli(home, ['restore-supervised', '--app-root', appRoot]);
  expect(restored).toMatchObject({ kind: 'restored', failedAppRoots: [] });
  const inventory = await runCli(home, ['status-all-supervised', '--app-root', appRoot]);
  expect(inventory).toMatchObject({ statuses: [{ classification: 'clean' }] });
  expect(fs.readdirSync(buildIslandPatchPaths(appRoot).workbenchDirPath)).toEqual([
    'workbench.html',
  ]);
});

test('concurrent CLI applies are serialized by the Island lock', async () => {
  const home = makeHome('concurrent');
  const appRoot = makeAppRoot('concurrent');
  const styles = ['first', 'second', 'third'].map((name) => writeCss(`${name}.css`, name));

  const results = await Promise.all(
    styles.map((cssSource) =>
      runCli(home, [
        'apply-supervised',
        '--app-root',
        appRoot,
        '--css-source',
        cssSource,
        '--theme-version',
        'test',
      ])
    )
  );

  for (const result of results) {
    expect(result).toMatchObject({
      status: { classification: 'patched', verificationPassed: true },
    });
  }
  const inventory = await runCli(home, ['status-all-supervised', '--app-root', appRoot]);
  expect(inventory).toMatchObject({
    statuses: [{ classification: 'patched', verificationPassed: true }],
  });
});

test('the bundled CLI converges an installation to its desired style', async () => {
  const home = makeHome('converge');
  const appRoot = makeAppRoot('converge');
  const cssSource = writeCss('tyrian-nocturne.css', 'plum');
  const islandDirectory = path.dirname(cssSource);
  await runCli(home, [
    'apply-supervised',
    '--app-root',
    appRoot,
    '--css-source',
    cssSource,
    '--theme-version',
    'test',
  ]);

  const converged = await runCli(home, [
    'converge',
    '--app-root',
    appRoot,
    '--island-dir',
    islandDirectory,
    '--theme-version',
    'test',
  ]);
  expect(converged).toMatchObject({
    action: 'apply',
    result: { kind: 'already-current', status: { desiredCssFile: 'tyrian-nocturne.css' } },
  });
});

test('a pipe lock admits one holder and frees its name on release', async () => {
  const pipePath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\tyrian-night-test-${crypto.randomUUID()}`
      : path.join(root, `lock-${crypto.randomUUID().slice(0, 8)}.sock`);
  const first = await holdPipeLock(pipePath, 5);
  if (first.kind !== 'held') throw new Error('The first pipe lock must be held.');

  await expect(holdPipeLock(pipePath, 0)).rejects.toMatchObject({ code: 'blocked' });

  let secondSettled = false;
  const second = holdPipeLock(pipePath, 5).finally(() => {
    secondSettled = true;
  });
  await Bun.sleep(400);
  expect(secondSettled).toBe(false);

  await first.release();
  const acquired = await second;
  expect(acquired.kind).toBe('held');
  if (acquired.kind === 'held') await acquired.release();
});

async function runCli(home: string, args: string[]): Promise<unknown> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== 'TYRIAN_ISLAND_LOCK_HELD')
  );
  const child = Bun.spawn(['node', cliPath, ...args], {
    // os.homedir() reads HOME on Linux and macOS and USERPROFILE on Windows.
    env: { ...environment, HOME: home, USERPROFILE: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Island CLI ${args[0]} exited ${exitCode}: ${stderr}`);
  return JSON.parse(stdout);
}

function makeHome(name: string): string {
  const home = path.join(root, `home-${name}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function makeAppRoot(name: string): string {
  const appRoot = path.join(root, `app-${name}`);
  const { productJsonPath, workbenchDirPath, workbenchHtmlPath } = buildIslandPatchPaths(appRoot);
  const html = `<!DOCTYPE html>\n<html>\n\t<head>\n\t\t${WORKBENCH_CSS_LINK}\n\t</head>\n</html>\n`;
  fs.mkdirSync(workbenchDirPath, { recursive: true });
  fs.writeFileSync(workbenchHtmlPath, html);
  fs.writeFileSync(
    productJsonPath,
    `${JSON.stringify({ checksums: { [WORKBENCH_CHECKSUM_KEY]: sha256Base64(html) } }, null, '\t')}\n`
  );
  return fs.realpathSync(appRoot);
}

function writeCss(name: string, color: string): string {
  const cssPath = path.join(root, name);
  fs.writeFileSync(cssPath, `.monaco-workbench { color: ${color}; }\n`);
  return cssPath;
}

function sha256Base64(content: string): string {
  return crypto.hash('sha256', content, 'base64').replace(/=+$/, '');
}
