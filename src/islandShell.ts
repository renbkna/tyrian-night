import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const WORKBENCH_DIR_RELATIVE_PATH = path.join('out', 'vs', 'code', 'electron-browser', 'workbench');
const WORKBENCH_HTML_RELATIVE_PATH = path.join(WORKBENCH_DIR_RELATIVE_PATH, 'workbench.html');
const PRODUCT_JSON_RELATIVE_PATH = 'product.json';
const WORKBENCH_CHECKSUM_KEY = 'vs/code/electron-browser/workbench/workbench.html';
const WORKBENCH_CSS_LINK =
  '<link rel="stylesheet" href="../../../workbench/workbench.desktop.main.css">';

const ISLAND_CSS_FILE_NAME = 'tyrian-night.island.css';
const ISLAND_MANIFEST_FILE_NAME = 'tyrian-night.island.json';
const BACKUP_HTML_FILE_NAME = 'tyrian-night.workbench.backup.html';
const BACKUP_PRODUCT_FILE_NAME = 'tyrian-night.product.backup.json';

const TYRIAN_MARKER_START = '<!-- Tyrian Night Island Start -->';
const TYRIAN_MARKER_END = '<!-- Tyrian Night Island End -->';
const TYRIAN_BLOCK_PATTERN = new RegExp(
  `${escapeRegExp(TYRIAN_MARKER_START)}[\\s\\S]*?${escapeRegExp(TYRIAN_MARKER_END)}\\s*`,
  'g'
);

type ProductJson = {
  checksums?: Record<string, string>;
};

type PatchPaths = {
  workbenchDirPath: string;
  workbenchHtmlPath: string;
  productJsonPath: string;
  islandCssPath: string;
  manifestPath: string;
  backupHtmlPath: string;
  backupProductJsonPath: string;
};

type IslandManifest = {
  version: 1;
  themeVersion: string;
  installedAt: string;
  checksum: string;
};

export type IslandShellStatus = {
  active: boolean;
  managed: boolean;
};

export type IslandShellResult = {
  changed: boolean;
  active: boolean;
};

export async function applyIslandShell(options: {
  appRoot: string;
  cssSourcePath: string;
  themeVersion: string;
}): Promise<IslandShellResult> {
  const paths = getPatchPaths(options.appRoot);
  const currentHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const currentProductJson = await fs.readFile(paths.productJsonPath, 'utf8');
  const cssSource = await fs.readFile(options.cssSourcePath, 'utf8');

  const baseHtml = stripTyrianBlock(currentHtml);
  const baseProductJson = setWorkbenchChecksum(currentProductJson, baseHtml);
  const patchedHtml = injectIslandStylesheet(baseHtml);
  const patchedProductJson = setWorkbenchChecksum(baseProductJson, patchedHtml);
  const manifest = serializeManifest({
    version: 1,
    themeVersion: options.themeVersion,
    installedAt: new Date().toISOString(),
    checksum: sha256Base64(patchedHtml),
  });

  let changed = false;

  await fs.mkdir(paths.workbenchDirPath, { recursive: true });
  changed = (await writeIfChanged(paths.backupHtmlPath, baseHtml)) || changed;
  changed = (await writeIfChanged(paths.backupProductJsonPath, baseProductJson)) || changed;
  changed = (await writeIfChanged(paths.islandCssPath, cssSource)) || changed;
  changed = (await writeIfChanged(paths.workbenchHtmlPath, patchedHtml)) || changed;
  changed = (await writeIfChanged(paths.productJsonPath, patchedProductJson)) || changed;
  changed = (await writeIfChanged(paths.manifestPath, manifest)) || changed;

  return {
    changed,
    active: true,
  };
}

export async function restoreIslandShell(options: { appRoot: string }): Promise<IslandShellResult> {
  const paths = getPatchPaths(options.appRoot);
  const currentHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const currentProductJson = await fs.readFile(paths.productJsonPath, 'utf8');

  const backupHtml = await readTextFileIfExists(paths.backupHtmlPath);
  const backupProductJson = await readTextFileIfExists(paths.backupProductJsonPath);

  const restoredHtml = backupHtml ?? stripTyrianBlock(currentHtml);
  const restoredProductJson =
    backupProductJson ?? setWorkbenchChecksum(currentProductJson, restoredHtml);

  let changed = false;

  changed = (await writeIfChanged(paths.workbenchHtmlPath, restoredHtml)) || changed;
  changed = (await writeIfChanged(paths.productJsonPath, restoredProductJson)) || changed;

  changed = (await deleteIfExists(paths.islandCssPath)) || changed;
  changed = (await deleteIfExists(paths.manifestPath)) || changed;
  changed = (await deleteIfExists(paths.backupHtmlPath)) || changed;
  changed = (await deleteIfExists(paths.backupProductJsonPath)) || changed;

  return {
    changed,
    active: false,
  };
}

export async function readIslandShellStatus(options: {
  appRoot: string;
}): Promise<IslandShellStatus> {
  const paths = getPatchPaths(options.appRoot);
  const currentHtml = await readTextFileIfExists(paths.workbenchHtmlPath);

  return {
    active: currentHtml?.includes(TYRIAN_MARKER_START) ?? false,
    managed:
      (await pathExists(paths.manifestPath)) ||
      (await pathExists(paths.backupHtmlPath)) ||
      (await pathExists(paths.backupProductJsonPath)) ||
      (await pathExists(paths.islandCssPath)),
  };
}

export async function findInstalledAppRoots(): Promise<string[]> {
  const candidates = new Set<string>();
  const executableDir = path.dirname(process.execPath);

  if (process.env.VSCODE_APP_ROOT) {
    candidates.add(process.env.VSCODE_APP_ROOT);
  }

  if (process.env.APPIMAGE) {
    candidates.add(path.join(path.dirname(process.env.APPIMAGE), 'resources', 'app'));
  }

  candidates.add(path.join(executableDir, 'resources', 'app'));
  candidates.add(path.join(executableDir, '..', 'resources', 'app'));
  candidates.add(path.join(executableDir, '..', '..', 'resources', 'app'));

  switch (process.platform) {
    case 'win32':
      if (process.env.LOCALAPPDATA) {
        candidates.add(
          path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'resources', 'app')
        );
      }
      if (process.env['ProgramFiles']) {
        candidates.add(
          path.join(process.env['ProgramFiles'], 'Microsoft VS Code', 'resources', 'app')
        );
      }
      if (process.env['ProgramFiles(x86)']) {
        candidates.add(
          path.join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'resources', 'app')
        );
      }
      break;
    case 'darwin':
      candidates.add('/Applications/Visual Studio Code.app/Contents/Resources/app');
      break;
    default:
      candidates.add('/opt/visual-studio-code/resources/app');
      candidates.add('/usr/share/code/resources/app');
      break;
  }

  const existingRoots: string[] = [];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const workbenchHtmlPath = path.join(candidate, WORKBENCH_HTML_RELATIVE_PATH);
    const productJsonPath = path.join(candidate, PRODUCT_JSON_RELATIVE_PATH);

    if ((await pathExists(workbenchHtmlPath)) && (await pathExists(productJsonPath))) {
      existingRoots.push(candidate);
    }
  }

  return existingRoots;
}

function getPatchPaths(appRoot: string): PatchPaths {
  const workbenchDirPath = path.join(appRoot, WORKBENCH_DIR_RELATIVE_PATH);

  return {
    workbenchDirPath,
    workbenchHtmlPath: path.join(appRoot, WORKBENCH_HTML_RELATIVE_PATH),
    productJsonPath: path.join(appRoot, PRODUCT_JSON_RELATIVE_PATH),
    islandCssPath: path.join(workbenchDirPath, ISLAND_CSS_FILE_NAME),
    manifestPath: path.join(workbenchDirPath, ISLAND_MANIFEST_FILE_NAME),
    backupHtmlPath: path.join(workbenchDirPath, BACKUP_HTML_FILE_NAME),
    backupProductJsonPath: path.join(workbenchDirPath, BACKUP_PRODUCT_FILE_NAME),
  };
}

function stripTyrianBlock(html: string): string {
  return html.replace(TYRIAN_BLOCK_PATTERN, '').trimEnd().concat('\n');
}

function injectIslandStylesheet(html: string): string {
  if (!html.includes(WORKBENCH_CSS_LINK)) {
    throw new Error(
      'Unsupported VS Code workbench HTML layout. Could not locate the stylesheet anchor.'
    );
  }

  const islandBlock =
    `${TYRIAN_MARKER_START}\n` +
    '\t\t<link rel="stylesheet" href="./tyrian-night.island.css">\n' +
    `\t\t${TYRIAN_MARKER_END}\n\t\t`;

  return html.replace(WORKBENCH_CSS_LINK, `${islandBlock}${WORKBENCH_CSS_LINK}`);
}

function setWorkbenchChecksum(productJsonContent: string, workbenchHtml: string): string {
  const parsed = JSON.parse(productJsonContent) as ProductJson;

  if (!parsed.checksums) {
    throw new Error('Unsupported product.json layout. Missing checksums object.');
  }

  if (!(WORKBENCH_CHECKSUM_KEY in parsed.checksums)) {
    throw new Error(
      `Unsupported product.json layout. Missing checksum key '${WORKBENCH_CHECKSUM_KEY}'.`
    );
  }

  parsed.checksums[WORKBENCH_CHECKSUM_KEY] = sha256Base64(workbenchHtml);
  return JSON.stringify(parsed, null, '\t').concat('\n');
}

function serializeManifest(manifest: IslandManifest): string {
  return JSON.stringify(manifest, null, 2).concat('\n');
}

function sha256Base64(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('base64').replace(/=+$/, '');
}

async function writeIfChanged(filePath: string, content: string): Promise<boolean> {
  const currentContent = await readTextFileIfExists(filePath);

  if (currentContent === content) {
    return false;
  }

  const tempPath = path.join(
    path.dirname(filePath),
    `.tyrian-night-${process.pid}-${Date.now()}-${path.basename(filePath)}.tmp`
  );

  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, filePath);
  return true;
}

async function deleteIfExists(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

async function readTextFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
