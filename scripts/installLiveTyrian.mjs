// @ts-check

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FASTFETCH_IMAGE_ASSET_PATH,
  FASTFETCH_IMAGE_HOME_PATH,
  TYRIAN_INSTALL_HOME,
  WALLPAPER_ASSET_PATH,
  buildTyrianBackupRoot,
} from './portableAssets.mjs';
import { TYRIAN_REQUIRED_COMMANDS, checkRequiredCommands, hasCommand } from './commandChecks.mjs';
import { buildFishConfig, buildGhosttyConfig } from './terminalThemes.mjs';
import { SOURCE_THEMES } from './themeSources.mjs';

const repoRoot = process.cwd();
const home = os.homedir();
const ghosttyThemeSlugs = SOURCE_THEMES.map((source) => source.slug);

/**
 * @typedef {'copy' | 'link'} InstallMode
 * @typedef {{ source: string; target: string }} CopyRoot
 * @typedef {(command: string, args: string[], options?: import('node:child_process').ExecFileSyncOptions) => Buffer | string} CommandRunner
 * @typedef {{
 *   mode: InstallMode;
 *   apply: boolean;
 *   repoRoot: string;
 *   home: string;
 *   installRoot: string;
 *   sourceRoot: string;
 *   backupRoot: string;
 *   materializedRoots: CopyRoot[];
 *   livePaths: Record<string, string>;
 *   sourcePaths: Record<string, string>;
 *   runCommand: CommandRunner;
 *   hasCommand: (command: string) => boolean;
 *   legacyPaths: string[];
 *   touchedPaths: string[];
 * }} LiveInstallPlan
 */

/**
 * @param {{ repoRoot?: string; home?: string; apply?: boolean; link?: boolean; runCommand?: CommandRunner; hasCommand?: (command: string) => boolean }} [options]
 * @returns {LiveInstallPlan}
 */
export function buildLiveInstallPlan(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const userHome = options.home ?? home;
  const mode = options.link ? 'link' : 'copy';
  const installRoot = path.join(userHome, TYRIAN_INSTALL_HOME);
  const sourceRoot = mode === 'link' ? root : installRoot;
  const livePaths = buildLivePaths(userHome);
  const legacyPaths = buildLegacyPaths(userHome);
  const sourcePaths = buildSourcePaths(sourceRoot);

  return {
    mode,
    apply: options.apply ?? false,
    repoRoot: root,
    home: userHome,
    installRoot,
    sourceRoot,
    backupRoot: buildTyrianBackupRoot(userHome, 'live-tyrian-apply'),
    materializedRoots:
      mode === 'copy'
        ? [
            { source: path.join(root, 'assets'), target: path.join(installRoot, 'assets') },
            { source: path.join(root, 'terminal'), target: path.join(installRoot, 'terminal') },
            { source: path.join(root, 'desktop'), target: path.join(installRoot, 'desktop') },
          ]
        : [
            {
              source: path.join(root, FASTFETCH_IMAGE_ASSET_PATH),
              target: path.join(userHome, FASTFETCH_IMAGE_HOME_PATH),
            },
            {
              source: path.join(root, 'assets/wallpaper-tyrian.png'),
              target: path.join(installRoot, 'assets/wallpaper-tyrian.png'),
            },
          ],
    livePaths,
    sourcePaths,
    runCommand: options.runCommand ?? execFileSync,
    hasCommand: options.hasCommand ?? hasCommand,
    legacyPaths,
    touchedPaths: buildTouchedPaths(livePaths, legacyPaths),
  };
}

/**
 * @param {{ repoRoot?: string; home?: string; apply?: boolean; link?: boolean; runCommand?: CommandRunner; hasCommand?: (command: string) => boolean }} [options]
 * @returns {void}
 */
export function installLiveTyrian(options = {}) {
  const plan = buildLiveInstallPlan(options);

  checkRequiredCommands(TYRIAN_REQUIRED_COMMANDS, plan.apply, plan.hasCommand, 'Tyrian runtime');
  validateInstallSources(plan);

  if (plan.apply) {
    backupExistingPaths(plan);
  }

  cleanupLegacyPaths(plan);
  materializeSourceRoot(plan);
  installTerminalLayer(plan);
  installDesktopLayer(plan);
  runPlasmaApply(plan);

  if (plan.apply) {
    console.log(`Live Tyrian install complete. Backup: ${plan.backupRoot}`);
  } else {
    console.log(
      `Dry run complete. Re-run with --apply to ${plan.mode === 'link' ? 'link live config to the repo' : `copy Tyrian into ${plan.installRoot}`}.`
    );
  }
}

/**
 * @param {string} userHome
 * @returns {Record<string, string>}
 */
function buildLivePaths(userHome) {
  return {
    ghosttyConfig: path.join(userHome, '.config/ghostty/config'),
    ghosttyCss: path.join(userHome, '.config/ghostty/ghostty.css'),
    ghosttyThemes: path.join(userHome, '.config/ghostty/themes'),
    fishConfig: path.join(userHome, '.local/share/caelestia/fish/config.fish'),
    fishGreeting: path.join(userHome, '.local/share/caelestia/fish/functions/fish_greeting.fish'),
    fastfetchConfig: path.join(userHome, '.local/share/caelestia/fastfetch/config.jsonc'),
    starshipConfig: path.join(userHome, '.local/share/caelestia/starship.toml'),
    kdeglobals: path.join(userHome, '.config/kdeglobals'),
    plasmarc: path.join(userHome, '.config/plasmarc'),
    screenLockerConfig: path.join(userHome, '.config/kscreenlockerrc'),
    kdeTyrianScheme: path.join(userHome, '.local/share/color-schemes/TyrianNight.colors'),
    plasmaTyrianTheme: path.join(userHome, '.local/share/plasma/desktoptheme/TyrianNight'),
    lookAndFeelTyrian: path.join(userHome, '.local/share/plasma/look-and-feel/TyrianNight'),
    caelestiaSchemeState: path.join(userHome, '.local/state/caelestia/scheme.json'),
    caelestiaSequences: path.join(userHome, '.local/state/caelestia/sequences.txt'),
    hyprCurrentScheme: path.join(userHome, '.config/hypr/scheme/current.conf'),
  };
}

/**
 * @param {string} userHome
 * @returns {string[]}
 */
function buildLegacyPaths(userHome) {
  const fastfetchRoot = path.join(userHome, '.local/share/caelestia/fastfetch');

  return [
    path.join(fastfetchRoot, 'sewerslvt.gif'),
    path.join(fastfetchRoot, 'tyrian-logo.png'),
    path.join(fastfetchRoot, 'tyrian-fetch.webp'),
  ];
}

/**
 * @param {string} sourceRoot
 * @returns {Record<string, string>}
 */
function buildSourcePaths(sourceRoot) {
  return {
    ghosttyCss: path.join(sourceRoot, 'terminal/ghostty/ghostty.css'),
    fishGreeting: path.join(sourceRoot, 'terminal/fish/functions/fish_greeting.fish'),
    fastfetchConfig: path.join(sourceRoot, 'terminal/fastfetch/tyrian-night.jsonc'),
    fastfetchImage: path.join(sourceRoot, FASTFETCH_IMAGE_ASSET_PATH),
    wallpaper: path.join(sourceRoot, WALLPAPER_ASSET_PATH),
    starshipConfig: path.join(sourceRoot, 'terminal/starship/tyrian-night.toml'),
    kdeTyrianScheme: path.join(sourceRoot, 'desktop/kde/color-schemes/TyrianNight.colors'),
    plasmaTyrianThemeRoot: path.join(sourceRoot, 'desktop/kde/plasma/desktoptheme/TyrianNight'),
    lookAndFeelTyrianRoot: path.join(sourceRoot, 'desktop/kde/plasma/look-and-feel/TyrianNight'),
    caelestiaSchemeState: path.join(sourceRoot, 'desktop/caelestia/state/tyrian-night.scheme.json'),
    hyprCurrentScheme: path.join(sourceRoot, 'desktop/caelestia/hypr/tyrian-night.conf'),
  };
}

/**
 * @param {Record<string, string>} livePaths
 * @param {string[]} legacyPaths
 * @returns {string[]}
 */
function buildTouchedPaths(livePaths, legacyPaths) {
  return [
    livePaths.ghosttyConfig,
    livePaths.ghosttyCss,
    ...ghosttyThemeSlugs.map((slug) => path.join(livePaths.ghosttyThemes, slug)),
    livePaths.fishConfig,
    livePaths.fishGreeting,
    livePaths.fastfetchConfig,
    livePaths.starshipConfig,
    livePaths.kdeglobals,
    livePaths.plasmarc,
    livePaths.screenLockerConfig,
    livePaths.kdeTyrianScheme,
    livePaths.plasmaTyrianTheme,
    livePaths.lookAndFeelTyrian,
    livePaths.caelestiaSchemeState,
    livePaths.caelestiaSequences,
    livePaths.hyprCurrentScheme,
    ...legacyPaths,
  ];
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {void}
 */
function validateInstallSources(plan) {
  const sourcePaths = [
    ...ghosttyThemeSlugs.map((slug) => path.join(plan.repoRoot, `terminal/ghostty/themes/${slug}`)),
    path.join(plan.repoRoot, 'terminal/ghostty/ghostty.css'),
    path.join(plan.repoRoot, 'terminal/fish/functions/fish_greeting.fish'),
    path.join(plan.repoRoot, 'terminal/fastfetch/tyrian-night.jsonc'),
    path.join(plan.repoRoot, FASTFETCH_IMAGE_ASSET_PATH),
    path.join(plan.repoRoot, WALLPAPER_ASSET_PATH),
    path.join(plan.repoRoot, 'terminal/starship/tyrian-night.toml'),
    path.join(plan.repoRoot, 'desktop/kde/color-schemes/TyrianNight.colors'),
    path.join(plan.repoRoot, 'desktop/kde/plasma/desktoptheme/TyrianNight'),
    path.join(plan.repoRoot, 'desktop/kde/plasma/look-and-feel/TyrianNight'),
    path.join(plan.repoRoot, 'desktop/caelestia/state/tyrian-night.scheme.json'),
    path.join(plan.repoRoot, 'desktop/caelestia/hypr/tyrian-night.conf'),
  ];

  for (const sourcePath of sourcePaths) {
    if (exists(sourcePath)) {
      continue;
    }

    throw new Error(`Missing Tyrian install source: ${path.relative(plan.repoRoot, sourcePath)}`);
  }
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {void}
 */
function materializeSourceRoot(plan) {
  if (plan.mode === 'copy') {
    operation(plan, `copy Tyrian install source to ${plan.installRoot}`, () => {
      fs.rmSync(plan.installRoot, { recursive: true, force: true });

      for (const root of plan.materializedRoots) {
        fs.mkdirSync(path.dirname(root.target), { recursive: true });
        fs.cpSync(root.source, root.target, {
          recursive: true,
          preserveTimestamps: true,
          verbatimSymlinks: true,
        });
      }
    });
    return;
  }

  for (const root of plan.materializedRoots) {
    installManagedPath(plan, root.source, root.target);
  }
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {void}
 */
function installTerminalLayer(plan) {
  for (const slug of ghosttyThemeSlugs) {
    installManagedPath(
      plan,
      path.join(plan.sourceRoot, `terminal/ghostty/themes/${slug}`),
      path.join(plan.livePaths.ghosttyThemes, slug)
    );
  }

  installManagedPath(plan, plan.sourcePaths.ghosttyCss, plan.livePaths.ghosttyCss);
  writeFile(
    plan,
    plan.livePaths.ghosttyConfig,
    buildGhosttyConfig({ gtkCustomCss: plan.livePaths.ghosttyCss })
  );

  writeFile(plan, plan.livePaths.fishConfig, buildFishConfig({ tyrianRoot: plan.sourceRoot }));
  installManagedPath(plan, plan.sourcePaths.fishGreeting, plan.livePaths.fishGreeting);
  installManagedPath(plan, plan.sourcePaths.fastfetchConfig, plan.livePaths.fastfetchConfig);
  installManagedPath(plan, plan.sourcePaths.starshipConfig, plan.livePaths.starshipConfig);
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {void}
 */
function cleanupLegacyPaths(plan) {
  for (const legacyPath of plan.legacyPaths) {
    operation(plan, `remove stale legacy path ${legacyPath}`, () => {
      fs.rmSync(legacyPath, { recursive: true, force: true });
    });
  }
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {void}
 */
function installDesktopLayer(plan) {
  installManagedPath(plan, plan.sourcePaths.kdeTyrianScheme, plan.livePaths.kdeTyrianScheme);
  installPlasmaDesktopTheme(plan);
  installLookAndFeelPackage(plan);
  writeKdePackageKeys(plan);
  patchScreenLockerConfig(plan);
  installManagedPath(
    plan,
    plan.sourcePaths.caelestiaSchemeState,
    plan.livePaths.caelestiaSchemeState
  );
  installManagedPath(plan, plan.sourcePaths.hyprCurrentScheme, plan.livePaths.hyprCurrentScheme);
  writeFile(
    plan,
    plan.livePaths.caelestiaSequences,
    buildCaelestiaSequences(
      readableSourcePath(plan, 'desktop/caelestia/state/tyrian-night.scheme.json')
    )
  );
}

/**
 * @param {LiveInstallPlan} plan
 * @param {string} sourcePath
 * @param {string} targetPath
 * @returns {void}
 */
function installManagedPath(plan, sourcePath, targetPath) {
  const verb = plan.mode === 'link' ? 'link' : 'copy';

  operation(plan, `${verb} ${sourcePath} -> ${targetPath}`, () => {
    installManagedPathRaw(plan, sourcePath, targetPath);
  });
}

/**
 * @param {LiveInstallPlan} plan
 * @param {string} sourcePath
 * @param {string} targetPath
 * @returns {void}
 */
function installManagedPathRaw(plan, sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.rmSync(targetPath, { recursive: true, force: true });

  if (plan.mode === 'link') {
    fs.symlinkSync(sourcePath, targetPath);
    return;
  }

  fs.cpSync(sourcePath, targetPath, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {void}
 */
function installPlasmaDesktopTheme(plan) {
  installManagedPath(
    plan,
    plan.sourcePaths.plasmaTyrianThemeRoot,
    plan.livePaths.plasmaTyrianTheme
  );
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {void}
 */
function installLookAndFeelPackage(plan) {
  installManagedPath(
    plan,
    plan.sourcePaths.lookAndFeelTyrianRoot,
    plan.livePaths.lookAndFeelTyrian
  );
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {void}
 */
function writeKdePackageKeys(plan) {
  operation(plan, 'set live KDE package keys to TyrianNight', () => {
    plan.runCommand('kwriteconfig6', [
      '--file',
      plan.livePaths.kdeglobals,
      '--group',
      'KDE',
      '--key',
      'LookAndFeelPackage',
      'TyrianNight',
    ]);
    plan.runCommand('kwriteconfig6', [
      '--file',
      plan.livePaths.kdeglobals,
      '--group',
      'General',
      '--key',
      'ColorScheme',
      'TyrianNight',
    ]);
    plan.runCommand('kwriteconfig6', [
      '--file',
      plan.livePaths.plasmarc,
      '--group',
      'Theme',
      '--key',
      'name',
      'TyrianNight',
    ]);
  });
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {void}
 */
function patchScreenLockerConfig(plan) {
  const existing = exists(plan.livePaths.screenLockerConfig)
    ? fs.readFileSync(plan.livePaths.screenLockerConfig, 'utf8')
    : '';

  writeFile(
    plan,
    plan.livePaths.screenLockerConfig,
    patchIniSection(existing, 'Greeter][Wallpaper][org.kde.image][General', {
      Image: plan.sourcePaths.wallpaper,
      PreviewImage: plan.sourcePaths.wallpaper,
    })
  );
}

/**
 * @param {string} content
 * @param {string} sectionName
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function patchIniSection(content, sectionName, values) {
  const sectionHeader = `[${sectionName}]`;
  const sectionPattern = new RegExp(
    `^\\[${escapeRegExp(sectionName)}\\]\\n(?:(?!^\\[).*(?:\\n|$))*`,
    'mu'
  );
  const normalizedContent = content.endsWith('\n') || content === '' ? content : `${content}\n`;
  const existingSection = normalizedContent.match(sectionPattern)?.[0];
  const patchedSection = patchIniSectionContent(existingSection ?? `${sectionHeader}\n`, values);

  if (existingSection) {
    return normalizedContent.replace(sectionPattern, patchedSection);
  }

  return `${normalizedContent.replace(/\s*$/u, '')}\n\n${patchedSection}`.replace(/^\n+/u, '');
}

/**
 * @param {string} sectionContent
 * @param {Record<string, string>} values
 * @returns {string}
 */
function patchIniSectionContent(sectionContent, values) {
  let patched = sectionContent.endsWith('\n') ? sectionContent : `${sectionContent}\n`;

  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, 'mu');

    patched = pattern.test(patched) ? patched.replace(pattern, line) : `${patched}${line}\n`;
  }

  return patched.endsWith('\n') ? patched : `${patched}\n`;
}

/**
 * @param {LiveInstallPlan} plan
 * @param {string} filePath
 * @param {string} content
 * @returns {void}
 */
function writeFile(plan, filePath, content) {
  operation(plan, `write ${filePath}`, () => {
    writeFileRaw(filePath, content);
  });
}

/**
 * @param {string} filePath
 * @param {string} content
 * @returns {void}
 */
function writeFileRaw(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * @param {LiveInstallPlan} plan
 * @param {string} relativePath
 * @returns {string}
 */
function readableSourcePath(plan, relativePath) {
  if (plan.mode === 'copy' && !plan.apply) {
    return path.join(plan.repoRoot, relativePath);
  }

  return path.join(plan.sourceRoot, relativePath);
}

/**
 * @param {string} schemePath
 * @returns {string}
 */
function buildCaelestiaSequences(schemePath) {
  const colours = JSON.parse(fs.readFileSync(schemePath, 'utf8')).colours;

  return (
    hexToAnsi(colours.onSurface, 10) +
    hexToAnsi(colours.surface, 11) +
    hexToAnsi(colours.secondary, 12) +
    hexToAnsi(colours.secondary, 17) +
    Array.from({ length: 16 }, (_, index) => hexToAnsi(colours[`term${index}`], 4, index)).join(
      ''
    ) +
    hexToAnsi(colours.primary, 4, 16) +
    hexToAnsi(colours.secondary, 4, 17) +
    hexToAnsi(colours.tertiary, 4, 18)
  );
}

/**
 * @param {string} color
 * @param {number[]} indexes
 * @returns {string}
 */
function hexToAnsi(color, ...indexes) {
  return `\x1b]${indexes.join(';')};rgb:${color.slice(0, 2)}/${color.slice(2, 4)}/${color.slice(4, 6)}\x1b\\`;
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {void}
 */
function runPlasmaApply(plan) {
  operation(plan, 'apply KDE color scheme TyrianNight', () => {
    try {
      plan.runCommand('plasma-apply-colorscheme', ['TyrianNight'], { stdio: 'inherit' });
      plan.runCommand('plasma-apply-desktoptheme', ['TyrianNight'], { stdio: 'inherit' });
    } catch (error) {
      console.error('KDE apply command failed; the TyrianNight files were still installed.');
      throw error;
    }
  });
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {void}
 */
function backupExistingPaths(plan) {
  for (const sourcePath of plan.touchedPaths) {
    if (!exists(sourcePath)) {
      continue;
    }

    const relativePath = path.relative(plan.home, sourcePath);

    if (relativePath.startsWith('..')) {
      continue;
    }

    const backupPath = path.join(plan.backupRoot, 'home', relativePath);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    const stat = fs.lstatSync(sourcePath);

    if (stat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(sourcePath), backupPath);
    } else {
      fs.cpSync(sourcePath, backupPath, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    }

    console.log(`backup: ${sourcePath} -> ${backupPath}`);
  }
}

/**
 * @param {LiveInstallPlan} plan
 * @param {string} message
 * @param {() => void} action
 * @returns {void}
 */
function operation(plan, message, action) {
  console.log(`${plan.apply ? 'apply' : 'dry-run'}: ${message}`);

  if (plan.apply) {
    action();
  }
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function exists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * @returns {void}
 */
function main() {
  const args = parseFlags(process.argv.slice(2), ['--apply', '--link']);

  installLiveTyrian({
    apply: args.has('--apply'),
    link: args.has('--link'),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}

/**
 * @param {string[]} argv
 * @param {string[]} allowedFlags
 * @returns {Set<string>}
 */
function parseFlags(argv, allowedFlags) {
  const allowed = new Set(allowedFlags);
  const parsed = new Set();

  for (const flag of argv) {
    if (!allowed.has(flag)) {
      throw new Error(`Unknown Tyrian live install flag '${flag}'.`);
    }

    parsed.add(flag);
  }

  return parsed;
}
