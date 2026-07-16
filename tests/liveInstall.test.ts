import { expect, setDefaultTimeout, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isExecutable } from '../scripts/commandChecks.mjs';
import {
  buildLiveInstallPlan,
  installLiveTyrian,
  LIVE_INSTALL_MIGRATION_RETIREMENT_RELATIVE_PATH,
  LIVE_INSTALL_OWNERSHIP_RELATIVE_PATH,
  patchIniSection,
  prepareLiveInstallRepository,
  recoverHomeFilesystemTransaction,
  recoverLiveTyrian,
  withHomeFilesystemTransaction,
} from '../scripts/installLiveTyrian.mjs';
import { exists, syncPathsDurably, withTokenFileLock } from '../scripts/installOps.mjs';
import {
  TYRIAN_BACKUP_HOME,
  TYRIAN_INSTALL_HOME,
  WALLPAPER_ASSET_PATH,
} from '../scripts/portableAssets.mjs';
import {
  buildFishStartupConfig,
  buildFootConfig,
  buildGhosttyConfig,
} from '../scripts/terminalThemes.mjs';

const FIXTURE_HOME = '/home/example';
setDefaultTimeout(30_000);

function resolveMutationPath(value: fs.PathLike): string {
  const requestedPath = String(value);
  const parentPath = path.dirname(requestedPath);
  return path.join(fs.realpathSync(parentPath), path.basename(requestedPath));
}

test('live install preparation materializes clean-checkout runtime assets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-prepare-'));

  try {
    copyWorkspaceManifests(root);
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });

    prepareLiveInstallRepository(root, { target: 'plasma' });

    expect(fs.existsSync(path.join(root, 'terminal/foot/themes/tyrian-nocturne.ini'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'terminal/fastfetch/tyrian-night.jsonc'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'desktop/kde/color-schemes/TyrianNight.colors'))).toBe(
      true
    );
    expect(
      fs.existsSync(
        path.join(root, 'desktop/kde/plasma/look-and-feel/TyrianNight/contents/defaults')
      )
    ).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live preview is observational on a clean checkout and destination home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-preview-repo-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-preview-home-'));

  try {
    copyWorkspaceManifests(root);
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    fs.cpSync('assets', path.join(root, 'assets'), { recursive: true });
    const repositoryBefore = snapshotTree(root);
    const homeBefore = snapshotTree(home);

    installLiveTyrian({ repoRoot: root, home, apply: false, target: 'plasma' });

    expect(snapshotTree(root)).toEqual(repositoryBefore);
    expect(snapshotTree(home)).toEqual(homeBefore);
    expect(fs.existsSync(path.join(home, '.tyrian-night-live-install.lock'))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live preparation rejects an install-root alias before changing generated outputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-prepare-alias-repo-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-prepare-alias-home-'));

  try {
    copyLiveInstallRepoFixture(root);
    const outputPath = path.join(root, 'terminal/ghostty/themes/tyrian-nocturne');
    const originalOutput = fs.readFileSync(outputPath, 'utf8');
    const installRoot = path.join(home, TYRIAN_INSTALL_HOME);
    fs.mkdirSync(path.dirname(installRoot), { recursive: true });
    fs.symlinkSync(root, installRoot);

    expect(() => prepareLiveInstallRepository(root, { home, target: 'plasma' })).toThrow(
      'repository and install root must not overlap'
    );
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(originalOutput);
    expect(fs.realpathSync(installRoot)).toBe(fs.realpathSync(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live preparation validates every output ancestor before the first generator write', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-prepare-output-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-prepare-output-home-'));

  try {
    copyLiveInstallRepoFixture(root);
    const earlierOutput = path.join(root, 'terminal/ghostty/themes/tyrian-nocturne');
    const originalOutput = fs.readFileSync(earlierOutput, 'utf8');
    const invalidAncestor = path.join(root, 'terminal/foot');
    fs.rmSync(invalidAncestor, { recursive: true });
    fs.writeFileSync(invalidAncestor, 'not a directory\n');

    expect(() => prepareLiveInstallRepository(root, { home, target: 'plasma' })).toThrow(
      'Generator output has an invalid existing path'
    );
    expect(fs.readFileSync(earlierOutput, 'utf8')).toBe(originalOutput);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live installer defaults to a repo-independent materialized install root', () => {
  const repoRoot = process.cwd();
  const plan = buildLiveInstallPlan({
    repoRoot,
    home: FIXTURE_HOME,
    target: 'plasma',
  });
  const nextPlan = buildLiveInstallPlan({
    repoRoot,
    home: FIXTURE_HOME,
    target: 'plasma',
  });
  const installRoot = `${FIXTURE_HOME}/${TYRIAN_INSTALL_HOME}`;

  expect(plan.mode).toBe('copy');
  expect(plan.installRoot).toBe(installRoot);
  expect(plan.sourceRoot).toBe(installRoot);
  expect(plan.backupRoot).toContain(`${FIXTURE_HOME}/${TYRIAN_BACKUP_HOME}/live-tyrian-apply-`);
  expect(plan.materializedRoots).toContainEqual({
    source: path.join(repoRoot, 'assets/tyrian-fetch.webp'),
    target: `${installRoot}/assets/tyrian-fetch.webp`,
  });
  expect(plan.materializedRoots).toContainEqual({
    source: path.join(repoRoot, 'terminal/foot/themes/tyrian-nocturne.ini'),
    target: `${installRoot}/terminal/foot/themes/tyrian-nocturne.ini`,
  });
  expect(plan.materializedRoots).toContainEqual({
    source: path.join(repoRoot, 'desktop/kde/plasma/desktoptheme/TyrianNight'),
    target: `${installRoot}/desktop/kde/plasma/desktoptheme/TyrianNight`,
  });
  expect(plan.materializedRoots.map(({ source }) => source)).not.toContain(
    path.join(repoRoot, 'terminal')
  );
  expect(plan.sourcePaths.fastfetchConfig).toBe(
    `${installRoot}/terminal/fastfetch/tyrian-night.jsonc`
  );
  expect(plan.sourcePaths.starshipConfig).toBe(
    `${installRoot}/terminal/starship/tyrian-night.toml`
  );
  expect(plan.sourcePaths.wallpaper).toBe(`${installRoot}/${WALLPAPER_ASSET_PATH}`);
  expect(JSON.stringify(plan.sourcePaths)).not.toContain('union');
  expect(plan.livePaths.screenLockerConfig).toBe(`${FIXTURE_HOME}/.config/kscreenlockerrc`);
  expect(plan.touchedPaths).toContain(`${FIXTURE_HOME}/.config/kscreenlockerrc`);
  expect(plan.touchedPaths).not.toContain(
    `${FIXTURE_HOME}/.config/environment.d/tyrian-union.conf`
  );
  expect(plan.touchedPaths).not.toContain(
    `${FIXTURE_HOME}/.local/share/union/css/styles/TyrianNight`
  );
  expect(plan.touchedPaths).not.toContain(`${FIXTURE_HOME}/.local/share/union/css/defaults`);
  expect(plan.legacyPaths).toEqual({
    common: [],
    plasma: [
      `${FIXTURE_HOME}/.local/share/union/css/styles/TyrianNight`,
      `${FIXTURE_HOME}/.config/environment.d/tyrian-union.conf`,
    ],
    caelestia: [
      `${FIXTURE_HOME}/.local/share/caelestia/fish/config.fish`,
      `${FIXTURE_HOME}/.local/share/caelestia/fish/functions/fish_greeting.fish`,
      `${FIXTURE_HOME}/.local/share/caelestia/fastfetch/sewerslvt.gif`,
      `${FIXTURE_HOME}/.local/share/caelestia/fastfetch/tyrian-logo.png`,
      `${FIXTURE_HOME}/.local/share/caelestia/fastfetch/tyrian-fetch.webp`,
      `${FIXTURE_HOME}/.local/share/caelestia/fastfetch/config.jsonc`,
      `${FIXTURE_HOME}/.local/share/caelestia/starship.toml`,
    ],
  });
  expect(JSON.stringify(plan.sourcePaths)).not.toContain(repoRoot);
  expect(plan.backupRoot).not.toContain(repoRoot);
  expect(nextPlan.backupRoot).not.toBe(plan.backupRoot);
});

test('live installer materializes full Tyrian rice targets without a Monochrome base', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-install-test-'));

  try {
    const fishConfig = path.join(home, '.config/fish/conf.d/tyrian-night.fish');
    const fishGreeting = path.join(home, '.config/fish/functions/fish_greeting.fish');
    const legacyFishConfig = path.join(home, '.local/share/caelestia/fish/config.fish');
    const legacyFishGreeting = path.join(
      home,
      '.local/share/caelestia/fish/functions/fish_greeting.fish'
    );
    const ghosttyConfig = path.join(home, '.config/ghostty/config');
    const ghosttyCss = path.join(home, '.config/ghostty/ghostty.css');
    const footConfig = path.join(home, '.config/foot/foot.ini');
    fs.mkdirSync(path.dirname(fishConfig), { recursive: true });
    fs.mkdirSync(path.dirname(fishGreeting), { recursive: true });
    fs.mkdirSync(path.dirname(legacyFishGreeting), { recursive: true });
    fs.mkdirSync(path.dirname(ghosttyConfig), { recursive: true });
    fs.mkdirSync(path.dirname(footConfig), { recursive: true });
    fs.writeFileSync(fishConfig, 'echo stale\n');
    fs.writeFileSync(fishGreeting, 'function fish_greeting\n    echo custom-greeting\nend\n');
    fs.writeFileSync(legacyFishConfig, 'echo stale legacy\n');
    fs.writeFileSync(legacyFishGreeting, 'function fish_greeting\n    echo stale legacy\nend\n');
    fs.writeFileSync(ghosttyConfig, 'font-size = 99\n');
    fs.writeFileSync(ghosttyCss, '/* obsolete static dark chrome */\n');
    fs.writeFileSync(footConfig, 'font=stale:size=99\n');
    fs.mkdirSync(path.join(home, '.local/share/union/css/styles/TyrianNight'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(home, '.local/share/union/css/styles/TyrianNight/style.css'),
      '/* stale Tyrian Union runtime */\n'
    );
    fs.writeFileSync(path.join(home, '.local/share/union/user-data.txt'), 'keep\n');

    installLiveTyrian({
      repoRoot: process.cwd(),
      home,
      apply: true,
      target: 'plasma',
    });

    const installRoot = path.join(home, TYRIAN_INSTALL_HOME);
    const footTheme = path.join(home, '.config/foot/themes/tyrian-nocturne.ini');
    const fishTheme = path.join(installRoot, 'terminal/fish/themes/tyrian-nocturne.fish');
    const kdeglobals = path.join(home, '.config/kdeglobals');
    const plasmarc = path.join(home, '.config/plasmarc');
    const unionEnvironment = path.join(home, '.config/environment.d/tyrian-union.conf');
    const tyrianDesktopTheme = path.join(home, '.local/share/plasma/desktoptheme/TyrianNight');
    const tyrianLookAndFeel = path.join(home, '.local/share/plasma/look-and-feel/TyrianNight');

    expect(fs.existsSync(path.join(home, '.local/share/plasma/desktoptheme/Monochrome'))).toBe(
      false
    );
    expect(fs.existsSync(path.join(tyrianDesktopTheme, 'metadata.json'))).toBe(true);
    expect(fs.existsSync(path.join(tyrianDesktopTheme, 'dialogs/background.svg'))).toBe(true);
    expect(fs.existsSync(path.join(tyrianLookAndFeel, 'contents/defaults'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.local/share/union/css/styles/TyrianNight'))).toBe(false);
    expect(fs.readFileSync(path.join(home, '.local/share/union/user-data.txt'), 'utf8')).toBe(
      'keep\n'
    );
    expect(fs.existsSync(unionEnvironment)).toBe(false);
    expect(fs.readFileSync(legacyFishConfig, 'utf8')).toBe('echo stale legacy\n');
    expect(fs.readFileSync(legacyFishGreeting, 'utf8')).toContain('echo stale legacy');
    expect(fs.readFileSync(fishConfig, 'utf8')).toBe(
      buildFishStartupConfig({ repoRoot: process.cwd(), tyrianRoot: installRoot })
    );
    expect(fs.existsSync(fishTheme)).toBe(true);
    expect(fs.readFileSync(fishConfig, 'utf8')).toContain(
      'source $TYRIAN_NIGHT_ROOT/terminal/fish/themes/tyrian-nocturne.fish'
    );
    expect(fs.readFileSync(fishGreeting, 'utf8')).toContain(
      'fastfetch --config $tyrian_night_root/terminal/fastfetch/tyrian-night.jsonc'
    );
    expect(fs.readFileSync(ghosttyConfig, 'utf8')).toBe(
      buildGhosttyConfig({ repoRoot: process.cwd() })
    );
    expect(fs.existsSync(ghosttyCss)).toBe(false);
    expect(fs.readFileSync(ghosttyConfig, 'utf8')).not.toContain('gtk-custom-css');
    expect(fs.readFileSync(ghosttyConfig, 'utf8')).not.toContain('window-titlebar-background');
    expect(
      fs.readFileSync(path.join(home, '.config/ghostty/themes/tyrian-dawn'), 'utf8')
    ).toContain('window-titlebar-background');
    expect(fs.readFileSync(footConfig, 'utf8')).toBe(
      buildFootConfig({ repoRoot: process.cwd(), themeDirectory: path.dirname(footTheme) })
    );
    expect(fs.existsSync(footTheme)).toBe(true);
    expect(fs.readFileSync(fishConfig, 'utf8')).not.toContain('custom-greeting');
    expect(fs.readFileSync(fishGreeting, 'utf8')).not.toContain('custom-greeting');
    expect(fs.readFileSync(ghosttyConfig, 'utf8')).not.toContain('font-size = 99');
    expect(fs.readFileSync(footConfig, 'utf8')).not.toContain('font=stale:size=99');
    expect(fs.readFileSync(kdeglobals, 'utf8')).toContain(
      '[KDE]\nLookAndFeelPackage=TyrianNight\nwidgetStyle=Breeze'
    );
    expect(fs.readFileSync(kdeglobals, 'utf8')).toContain('[General]\nColorScheme=TyrianNight');
    expect(fs.readFileSync(plasmarc, 'utf8')).toContain('[Theme]\nname=TyrianNight');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Caelestia target follows the active Hyprland provider and honors XDG roots', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-xdg-home-'));
  const environment = {
    XDG_CONFIG_HOME: path.join(home, 'xdg/config'),
    XDG_DATA_HOME: path.join(home, 'xdg/data'),
    XDG_STATE_HOME: path.join(home, 'xdg/state'),
  };
  const staleLegacyConfig = path.join(environment.XDG_CONFIG_HOME, 'hypr/hyprland.conf');
  const runCommand = () => JSON.stringify({ configProvider: 'lua' });

  try {
    fs.mkdirSync(path.dirname(staleLegacyConfig), { recursive: true });
    fs.writeFileSync(staleLegacyConfig, 'source = ./scheme/current.conf\n');

    const plan = buildLiveInstallPlan({
      repoRoot: process.cwd(),
      home,
      environment,
      target: 'caelestia',
      runCommand,
    });
    expect(plan.hyprlandMode).toBe('lua');
    expect(plan.livePaths.hyprCurrentScheme).toBe(
      path.join(environment.XDG_CONFIG_HOME, 'hypr/scheme/current.lua')
    );
    expect(plan.livePaths.caelestiaSchemeState).toBe(
      path.join(environment.XDG_STATE_HOME, 'caelestia/scheme.json')
    );

    installLiveTyrian({
      repoRoot: process.cwd(),
      home,
      environment,
      apply: true,
      target: 'caelestia',
      runCommand,
    });

    expect(fs.readFileSync(plan.livePaths.hyprCurrentScheme, 'utf8')).toContain('return {');
    expect(fs.existsSync(path.join(environment.XDG_CONFIG_HOME, 'hypr/scheme/current.conf'))).toBe(
      false
    );
    expect(fs.existsSync(plan.livePaths.caelestiaSchemeState)).toBe(true);
    expect(
      fs.existsSync(path.join(environment.XDG_DATA_HOME, 'caelestia/fastfetch/config.jsonc'))
    ).toBe(false);
    expect(fs.existsSync(path.join(home, '.config/hypr/scheme/current.lua'))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('no-manifest migration reconciles the complete fixed-root install before retirement', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'tyrian-live-fixed-root-migration-repo-')
  );
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-fixed-root-migration-'));
  const environment = {
    XDG_CONFIG_HOME: path.join(home, 'xdg/config'),
    XDG_DATA_HOME: path.join(home, 'xdg/data'),
    XDG_STATE_HOME: path.join(home, 'xdg/state'),
  };
  const installRoot = path.join(home, TYRIAN_INSTALL_HOME);
  const staleInstallFile = path.join(installRoot, 'terminal/pre-registry-only.txt');
  const staleDesktopFile = path.join(installRoot, 'desktop/pre-registry-only.txt');
  const preRegistryThemeSlugs = [
    'tyrian-night',
    'tyrian-nocturne',
    'tyrian-night-old',
    'tyrian-abyss',
    'tyrian-dawn',
  ];
  const fixedCommonPaths = [
    path.join(home, '.config/ghostty/config'),
    path.join(home, '.config/ghostty/ghostty.css'),
    ...preRegistryThemeSlugs.map((slug) => path.join(home, `.config/ghostty/themes/${slug}`)),
  ];
  const fixedPlasmaPaths = [
    path.join(home, '.config/kdeglobals'),
    path.join(home, '.config/plasmarc'),
    path.join(home, '.config/kscreenlockerrc'),
    path.join(home, '.local/share/color-schemes/TyrianNight.colors'),
    path.join(home, '.local/share/plasma/desktoptheme/TyrianNight'),
    path.join(home, '.local/share/plasma/look-and-feel/TyrianNight'),
  ];
  const fixedCaelestiaPaths = [
    path.join(home, '.local/share/caelestia/fish/config.fish'),
    path.join(home, '.local/share/caelestia/fish/functions/fish_greeting.fish'),
    path.join(home, '.local/share/caelestia/fastfetch/config.jsonc'),
    path.join(home, '.local/share/caelestia/starship.toml'),
    path.join(home, '.local/state/caelestia/scheme.json'),
    path.join(home, '.local/state/caelestia/sequences.txt'),
    path.join(home, '.config/hypr/scheme/current.conf'),
  ];
  const transitionalCaelestiaPaths = [
    path.join(environment.XDG_DATA_HOME, 'caelestia/fastfetch/config.jsonc'),
    path.join(environment.XDG_DATA_HOME, 'caelestia/starship.toml'),
  ];
  const transitionalGhosttyCss = path.join(environment.XDG_CONFIG_HOME, 'ghostty/ghostty.css');

  try {
    copyLiveInstallRepoFixture(repositoryRoot);

    for (const filePath of [
      staleInstallFile,
      staleDesktopFile,
      ...fixedCommonPaths,
      ...fixedPlasmaPaths,
      ...fixedCaelestiaPaths,
      ...transitionalCaelestiaPaths,
      transitionalGhosttyCss,
    ]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `pre-registry:${path.relative(home, filePath)}\n`);
    }

    installLiveTyrian({
      repoRoot: repositoryRoot,
      home,
      environment,
      apply: true,
      link: true,
      target: 'plasma',
    });

    expect(fs.existsSync(staleInstallFile)).toBe(false);
    expect(fs.existsSync(staleDesktopFile)).toBe(false);
    for (const materializedRoot of buildLiveInstallPlan({
      repoRoot: repositoryRoot,
      home,
      environment,
      link: true,
      target: 'plasma',
    }).materializedRoots) {
      expect(fs.lstatSync(materializedRoot.target).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(materializedRoot.target)).toBe(
        fs.realpathSync(materializedRoot.source)
      );
    }
    for (const historicalPath of [...fixedCommonPaths, ...fixedPlasmaPaths]) {
      expect(fs.existsSync(historicalPath)).toBe(false);
    }
    for (const historicalPath of [...fixedCaelestiaPaths, ...transitionalCaelestiaPaths]) {
      expect(fs.readFileSync(historicalPath, 'utf8')).toContain('pre-registry:');
    }
    expect(fs.existsSync(transitionalGhosttyCss)).toBe(false);

    const ownershipManifest = JSON.parse(
      fs.readFileSync(path.join(home, LIVE_INSTALL_OWNERSHIP_RELATIVE_PATH), 'utf8')
    );
    const migratedCaelestiaPaths = [...fixedCaelestiaPaths, ...transitionalCaelestiaPaths].map(
      (filePath) => path.relative(home, filePath)
    );
    expect(ownershipManifest.profiles.caelestia).toEqual(
      expect.arrayContaining(migratedCaelestiaPaths)
    );
    expect(fs.existsSync(path.join(home, LIVE_INSTALL_MIGRATION_RETIREMENT_RELATIVE_PATH))).toBe(
      true
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('live installer link mode is explicit and repo-dependent', () => {
  const repoRoot = process.cwd();
  const plan = buildLiveInstallPlan({
    repoRoot,
    home: FIXTURE_HOME,
    link: true,
    target: 'plasma',
  });

  expect(plan.mode).toBe('link');
  expect(plan.installRoot).toBe(`${FIXTURE_HOME}/${TYRIAN_INSTALL_HOME}`);
  expect(plan.sourceRoot).toBe(repoRoot);
  expect(plan.sourcePaths.fastfetchConfig).toBe(
    path.join(repoRoot, 'terminal/fastfetch/tyrian-night.jsonc')
  );
  expect(JSON.stringify(plan.sourcePaths)).not.toContain('union');
  expect(plan.materializedRoots).toContainEqual({
    source: path.join(repoRoot, 'assets/tyrian-fetch.webp'),
    target: `${FIXTURE_HOME}/${TYRIAN_INSTALL_HOME}/assets/tyrian-fetch.webp`,
  });
  expect(plan.sourcePaths.wallpaper).toBe(path.join(repoRoot, 'assets/wallpaper-tyrian.png'));
});

test('live plans require one desktop target and isolate its owned projections', () => {
  expect(() =>
    buildLiveInstallPlan({
      repoRoot: process.cwd(),
      home: FIXTURE_HOME,
      target: undefined as never,
    })
  ).toThrow('requires target "plasma" or "caelestia"');

  let providerProbeRan = false;
  const plasma = buildLiveInstallPlan({
    repoRoot: process.cwd(),
    home: FIXTURE_HOME,
    target: 'plasma',
    runCommand: () => {
      providerProbeRan = true;
      throw new Error('Plasma must not inspect Hyprland');
    },
  });
  const caelestia = buildLiveInstallPlan({
    repoRoot: process.cwd(),
    home: FIXTURE_HOME,
    target: 'caelestia',
    hyprlandMode: 'legacy',
  });

  expect(providerProbeRan).toBe(false);
  expect(plasma.hyprlandMode).toBeUndefined();
  expect(plasma.targetOwnedPaths).toContain(`${FIXTURE_HOME}/.config/kdeglobals`);
  expect(plasma.targetOwnedPaths).not.toContain(
    `${FIXTURE_HOME}/.local/state/caelestia/scheme.json`
  );
  expect(plasma.commonOwnedPaths).not.toContain(
    `${FIXTURE_HOME}/.local/share/caelestia/fastfetch/config.jsonc`
  );
  expect(caelestia.targetOwnedPaths).toContain(`${FIXTURE_HOME}/.config/hypr/scheme/current.conf`);
  expect(caelestia.targetOwnedPaths).not.toContain(
    `${FIXTURE_HOME}/.local/share/caelestia/fastfetch/config.jsonc`
  );
  expect(caelestia.targetOwnedPaths).not.toContain(`${FIXTURE_HOME}/.config/kdeglobals`);
  expect(() =>
    buildLiveInstallPlan({
      repoRoot: process.cwd(),
      home: FIXTURE_HOME,
      target: 'plasma',
      hyprlandMode: 'lua',
    })
  ).toThrow('Hyprland mode is only valid for the Caelestia target');
});

test('Hyprland provider detection is authoritative and explicit mode supports offline installs', () => {
  let observedCommand: { command: string; args: string[] } | undefined;
  const legacy = buildLiveInstallPlan({
    repoRoot: process.cwd(),
    home: FIXTURE_HOME,
    target: 'caelestia',
    runCommand: (command, args) => {
      observedCommand = { command, args };
      return JSON.stringify({ configProvider: 'hyprlang' });
    },
  });

  expect(observedCommand).toEqual({ command: 'hyprctl', args: ['-j', 'status'] });
  expect(legacy.hyprlandMode).toBe('legacy');
  expect(legacy.livePaths.hyprCurrentScheme).toBe(
    `${FIXTURE_HOME}/.config/hypr/scheme/current.conf`
  );
  expect(() =>
    buildLiveInstallPlan({
      repoRoot: process.cwd(),
      home: FIXTURE_HOME,
      target: 'caelestia',
      runCommand: () => JSON.stringify({ configProvider: 'future-provider' }),
    })
  ).toThrow('Unsupported Hyprland config provider');
  expect(() =>
    buildLiveInstallPlan({
      repoRoot: process.cwd(),
      home: FIXTURE_HOME,
      target: 'caelestia',
      runCommand: () => {
        throw new Error('offline');
      },
    })
  ).toThrow('pass --hyprland-mode=lua|legacy');
  expect(() =>
    buildLiveInstallPlan({
      repoRoot: process.cwd(),
      home: FIXTURE_HOME,
      target: 'caelestia',
    })
  ).toThrow('Cannot infer Hyprland mode for a different destination home');

  const offline = buildLiveInstallPlan({
    repoRoot: process.cwd(),
    home: FIXTURE_HOME,
    target: 'caelestia',
    hyprlandMode: 'lua',
    runCommand: () => {
      throw new Error('explicit mode must not probe Hyprland');
    },
  });
  expect(offline.hyprlandMode).toBe('lua');
});

test('desktop applies preserve the other target and Caelestia mode switches remove stale output', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-target-isolation-'));
  const caelestiaState = path.join(home, '.local/state/caelestia/scheme.json');
  const obsoleteCaelestiaFastfetch = path.join(
    home,
    '.local/share/caelestia/fastfetch/config.jsonc'
  );
  const kdeglobals = path.join(home, '.config/kdeglobals');

  try {
    fs.mkdirSync(path.dirname(caelestiaState), { recursive: true });
    fs.mkdirSync(path.dirname(obsoleteCaelestiaFastfetch), { recursive: true });
    fs.writeFileSync(caelestiaState, 'user-owned Caelestia state\n');
    fs.writeFileSync(obsoleteCaelestiaFastfetch, 'obsolete Tyrian projection\n');

    installLiveTyrian({
      repoRoot: process.cwd(),
      home,
      apply: true,
      target: 'plasma',
    });
    expect(fs.readFileSync(caelestiaState, 'utf8')).toBe('user-owned Caelestia state\n');
    expect(fs.readFileSync(obsoleteCaelestiaFastfetch, 'utf8')).toBe(
      'obsolete Tyrian projection\n'
    );
    const plasmaGeneration = fs.readFileSync(kdeglobals, 'utf8');

    installLiveTyrian({
      repoRoot: process.cwd(),
      home,
      apply: true,
      target: 'caelestia',
      hyprlandMode: 'legacy',
    });
    const legacyProjection = path.join(home, '.config/hypr/scheme/current.conf');
    expect(fs.existsSync(legacyProjection)).toBe(true);
    expect(fs.existsSync(obsoleteCaelestiaFastfetch)).toBe(false);
    expect(fs.readFileSync(kdeglobals, 'utf8')).toBe(plasmaGeneration);

    installLiveTyrian({
      repoRoot: process.cwd(),
      home,
      apply: true,
      target: 'caelestia',
      hyprlandMode: 'lua',
    });
    expect(fs.existsSync(legacyProjection)).toBe(false);
    expect(fs.existsSync(path.join(home, '.config/hypr/scheme/current.lua'))).toBe(true);
    expect(fs.readFileSync(kdeglobals, 'utf8')).toBe(plasmaGeneration);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(home, '.local/state/tyrian-night/live-owned-paths.json'), 'utf8')
    );
    expect(manifest.version).toBe(2);
    expect(manifest.owner).toBe('Tyrian Night live install');
    expect(Object.keys(manifest.profiles).toSorted()).toEqual(['caelestia', 'common', 'plasma']);
    expect(Array.isArray(manifest.profiles.common)).toBe(true);
    expect(manifest.profiles.plasma).toContain('.config/kdeglobals');
    expect(manifest.profiles.caelestia).toContain('.config/hypr/scheme/current.lua');
    expect(manifest.profiles.caelestia).not.toContain('.config/hypr/scheme/current.conf');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('v1 mixed ownership migrates without deleting the unselected desktop profile', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-v1-profile-migration-'));
  const ownershipManifest = path.join(home, '.local/state/tyrian-night/live-owned-paths.json');
  const caelestiaState = path.join(home, '.local/state/caelestia/scheme.json');
  const legacyProjection = path.join(home, '.config/hypr/scheme/current.conf');

  try {
    for (const filePath of [caelestiaState, legacyProjection]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `preserve:${path.basename(filePath)}\n`);
    }
    fs.mkdirSync(path.dirname(ownershipManifest), { recursive: true });
    fs.writeFileSync(
      ownershipManifest,
      `${JSON.stringify({
        version: 1,
        owner: 'Tyrian Night live install',
        paths: [
          '.config/kdeglobals',
          '.local/state/caelestia/scheme.json',
          '.config/hypr/scheme/current.conf',
        ],
      })}\n`
    );

    installLiveTyrian({
      repoRoot: process.cwd(),
      home,
      apply: true,
      target: 'plasma',
    });

    expect(fs.readFileSync(caelestiaState, 'utf8')).toBe('preserve:scheme.json\n');
    expect(fs.readFileSync(legacyProjection, 'utf8')).toBe('preserve:current.conf\n');
    const migrated = JSON.parse(fs.readFileSync(ownershipManifest, 'utf8'));
    expect(migrated.version).toBe(2);
    expect(migrated.profiles.caelestia).toEqual([
      '.config/hypr/scheme/current.conf',
      '.local/state/caelestia/scheme.json',
    ]);
    expect(migrated.profiles.plasma).toContain('.config/kdeglobals');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('v1 fixed Foot and Fish ownership follows a later custom XDG root', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-v1-xdg-migration-'));
  const environment = {
    XDG_CONFIG_HOME: path.join(home, 'xdg/config'),
    XDG_DATA_HOME: path.join(home, 'xdg/data'),
    XDG_STATE_HOME: path.join(home, 'xdg/state'),
  };
  const ownershipManifest = path.join(home, LIVE_INSTALL_OWNERSHIP_RELATIVE_PATH);
  const v1ThemeSlugs = [
    'tyrian-night',
    'tyrian-nocturne',
    'tyrian-night-old',
    'tyrian-abyss',
    'tyrian-dawn',
  ];
  const fixedFootConfig = path.join(home, '.config/foot/foot.ini');
  const fixedFootThemes = v1ThemeSlugs.map((slug) =>
    path.join(home, `.config/foot/themes/${slug}.ini`)
  );
  const fixedFishStartup = path.join(home, '.config/fish/conf.d/tyrian-night.fish');
  const fixedFishGreeting = path.join(home, '.config/fish/functions/fish_greeting.fish');
  const fixedPaths = [fixedFootConfig, ...fixedFootThemes, fixedFishStartup, fixedFishGreeting];

  try {
    for (const filePath of fixedPaths) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `v1:${path.relative(home, filePath)}\n`);
    }
    fs.mkdirSync(path.dirname(ownershipManifest), { recursive: true });
    fs.writeFileSync(
      ownershipManifest,
      `${JSON.stringify({
        version: 1,
        owner: 'Tyrian Night live install',
        paths: fixedPaths.map((filePath) => path.relative(home, filePath)),
      })}\n`
    );

    installLiveTyrian({
      repoRoot: process.cwd(),
      home,
      environment,
      apply: true,
      target: 'plasma',
    });

    for (const fixedPath of fixedPaths) {
      expect(fs.existsSync(fixedPath)).toBe(false);
    }

    const currentPlan = buildLiveInstallPlan({
      repoRoot: process.cwd(),
      home,
      environment,
      target: 'plasma',
    });
    expect(fs.existsSync(currentPlan.livePaths.footConfig)).toBe(true);
    for (const slug of v1ThemeSlugs) {
      expect(fs.existsSync(path.join(currentPlan.livePaths.footThemes, `${slug}.ini`))).toBe(true);
    }
    expect(fs.existsSync(currentPlan.livePaths.fishStartupConfig)).toBe(true);
    expect(fs.existsSync(currentPlan.livePaths.fishGreeting)).toBe(true);

    const migrated = JSON.parse(fs.readFileSync(ownershipManifest, 'utf8'));
    expect(migrated.version).toBe(2);
    for (const fixedPath of fixedPaths) {
      expect(migrated.profiles.common).not.toContain(path.relative(home, fixedPath));
    }
    for (const currentPath of [
      currentPlan.livePaths.footConfig,
      ...v1ThemeSlugs.map((slug) => path.join(currentPlan.livePaths.footThemes, `${slug}.ini`)),
      currentPlan.livePaths.fishStartupConfig,
      currentPlan.livePaths.fishGreeting,
    ]) {
      expect(migrated.profiles.common).toContain(path.relative(home, currentPath));
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live installer validates repo sources before touching live config', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-preflight-home-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-preflight-repo-'));
  const ghosttyConfig = path.join(home, '.config/ghostty/config');

  try {
    fs.cpSync(path.join(process.cwd(), 'source'), path.join(repoRoot, 'source'), {
      recursive: true,
    });
    fs.mkdirSync(path.dirname(ghosttyConfig), { recursive: true });
    fs.writeFileSync(ghosttyConfig, 'font-size = 99\n');

    expect(() =>
      installLiveTyrian({
        repoRoot,
        home,
        apply: true,
        target: 'plasma',
      })
    ).toThrow('Missing Tyrian install source: assets/tyrian-fetch.webp');
    expect(fs.readFileSync(ghosttyConfig, 'utf8')).toBe('font-size = 99\n');
    expect(fs.existsSync(path.join(home, TYRIAN_BACKUP_HOME))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('live installer renders from its injected repo and materializes only declared assets', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-root-home-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-root-repo-'));

  try {
    copyLiveInstallRepoFixture(repoRoot);
    const catalogPath = path.join(repoRoot, 'source/themeCatalog.json');
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as Array<{ slug: string }>;
    fs.writeFileSync(
      catalogPath,
      `${JSON.stringify(
        catalog.filter(({ slug }) => slug !== 'tyrian-abyss'),
        null,
        2
      )}\n`
    );
    fs.rmSync(path.join(repoRoot, 'source/themes/tyrian-abyss.json'));
    const themePath = path.join(repoRoot, 'source/themes/tyrian-nocturne.json');
    const theme = JSON.parse(fs.readFileSync(themePath, 'utf8'));
    theme.pigments['ui:surface.canvas'] = '#112233';
    theme.pigments['ui:text.primary'] = '#DDEEFF';
    fs.writeFileSync(themePath, `${JSON.stringify(theme, null, 2)}\n`);
    fs.writeFileSync(path.join(repoRoot, 'terminal/ghostty/themes/tyrian-stale'), 'stale\n');

    prepareLiveInstallRepository(repoRoot, { home, target: 'plasma' });
    installLiveTyrian({
      repoRoot,
      home,
      apply: true,
      target: 'plasma',
    });

    const installRoot = path.join(home, TYRIAN_INSTALL_HOME);
    const ghosttyConfig = fs.readFileSync(path.join(home, '.config/ghostty/config'), 'utf8');

    expect(ghosttyConfig).not.toContain('window-titlebar-background');
    const installedNocturne = fs.readFileSync(
      path.join(home, '.config/ghostty/themes/tyrian-nocturne'),
      'utf8'
    );
    expect(installedNocturne).toContain('window-titlebar-background = #112233');
    expect(installedNocturne).toContain('window-titlebar-foreground = #DDEEFF');
    expect(fs.existsSync(path.join(installRoot, 'terminal/ghostty/themes/tyrian-stale'))).toBe(
      false
    );
    expect(fs.existsSync(path.join(installRoot, 'terminal/ghostty/themes/tyrian-abyss'))).toBe(
      false
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('live installer validates generated content before backup or mutation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-content-home-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-content-repo-'));
  const ghosttyConfig = path.join(home, '.config/ghostty/config');

  try {
    copyLiveInstallRepoFixture(repoRoot);
    fs.writeFileSync(
      path.join(repoRoot, 'desktop/caelestia/state/tyrian-night.scheme.json'),
      '{ invalid json'
    );
    fs.mkdirSync(path.dirname(ghosttyConfig), { recursive: true });
    fs.writeFileSync(ghosttyConfig, 'font-size = 99\n');

    expect(() =>
      installLiveTyrian({
        repoRoot,
        home,
        apply: true,
        target: 'caelestia',
        hyprlandMode: 'lua',
      })
    ).toThrow();
    expect(fs.readFileSync(ghosttyConfig, 'utf8')).toBe('font-size = 99\n');
    expect(fs.existsSync(path.join(home, TYRIAN_BACKUP_HOME))).toBe(false);
    expect(fs.existsSync(path.join(home, TYRIAN_INSTALL_HOME))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('live installer rejects wrong source types before replacing the managed runtime', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-type-home-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-type-repo-'));
  const installRoot = path.join(home, TYRIAN_INSTALL_HOME);
  const markerPath = path.join(installRoot, 'existing.txt');

  try {
    copyLiveInstallRepoFixture(repoRoot);
    const fishThemePath = path.join(repoRoot, 'terminal/fish/themes/tyrian-nocturne.fish');
    fs.rmSync(fishThemePath);
    fs.mkdirSync(fishThemePath);
    fs.mkdirSync(installRoot, { recursive: true });
    fs.writeFileSync(markerPath, 'existing runtime\n');

    expect(() =>
      installLiveTyrian({
        repoRoot,
        home,
        apply: true,
        target: 'plasma',
      })
    ).toThrow('terminal/fish/themes/tyrian-nocturne.fish must be a file');
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('existing runtime\n');
    expect(fs.existsSync(path.join(home, TYRIAN_BACKUP_HOME))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('install path existence only treats missing paths as absent', () => {
  expect(exists(path.join(os.tmpdir(), 'tyrian-path-that-does-not-exist'))).toBe(false);
  expect(() => exists('\0')).toThrow();
});

test('live installer uses a fresh backup root for repeated apply operations', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-repeat-test-'));
  const targetConfig = path.join(home, 'fish-target.fish');
  const fishConfig = path.join(home, '.config/fish/conf.d/tyrian-night.fish');
  const sequencesPath = path.join(home, '.local/state/caelestia/sequences.txt');

  try {
    fs.mkdirSync(path.dirname(fishConfig), { recursive: true });
    fs.writeFileSync(targetConfig, 'original\n');
    fs.symlinkSync(targetConfig, fishConfig);

    const options = {
      repoRoot: process.cwd(),
      home,
      apply: true,
      target: 'caelestia' as const,
      hyprlandMode: 'legacy' as const,
    };

    expect(() => installLiveTyrian(options)).not.toThrow();
    fs.writeFileSync(targetConfig, 'customized again\n');
    fs.writeFileSync(sequencesPath, 'old complete sequence generation\n');
    const originalRename = fs.renameSync;
    let sequencePublicationObserved = false;
    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (!sequencePublicationObserved && resolveMutationPath(newPath) === sequencesPath) {
        expect(fs.readFileSync(sequencesPath, 'utf8')).toBe('old complete sequence generation\n');
        expect(fs.readFileSync(oldPath).length).toBeGreaterThan(0);
        sequencePublicationObserved = true;
        const result = originalRename(oldPath, newPath);
        expect(fs.readFileSync(sequencesPath, 'utf8')).not.toBe(
          'old complete sequence generation\n'
        );
        return result;
      }
      return originalRename(oldPath, newPath);
    }) as typeof fs.renameSync;
    try {
      expect(() => installLiveTyrian(options)).not.toThrow();
    } finally {
      fs.renameSync = originalRename;
    }
    expect(sequencePublicationObserved).toBe(true);

    const backupRoot = path.join(home, TYRIAN_BACKUP_HOME);
    const backupDirs = fs
      .readdirSync(backupRoot)
      .filter((entry) => entry.startsWith('live-tyrian-apply-'));

    expect(backupDirs.length).toBeGreaterThanOrEqual(2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live installer rejects repository and install-root aliases before mutation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-alias-home-'));
  const installRoot = path.join(home, TYRIAN_INSTALL_HOME);
  const sourceRoot = process.cwd();

  try {
    fs.mkdirSync(path.dirname(installRoot), { recursive: true });
    fs.symlinkSync(sourceRoot, installRoot);

    expect(() =>
      installLiveTyrian({
        repoRoot: sourceRoot,
        home,
        apply: true,
        target: 'plasma',
      })
    ).toThrow('repository and install root must not overlap');
    expect(fs.realpathSync(installRoot)).toBe(fs.realpathSync(sourceRoot));
    expect(fs.existsSync(path.join(home, TYRIAN_BACKUP_HOME))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live installer rejects a repository inside any live destination before mutation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-repo-target-home-'));
  const repositoryRoot = path.join(home, '.config/ghostty/themes');

  try {
    fs.mkdirSync(repositoryRoot, { recursive: true });
    copyLiveInstallRepoFixture(repositoryRoot);
    const packagePath = path.join(repositoryRoot, 'package.json');
    const originalPackage = fs.readFileSync(packagePath, 'utf8');

    expect(() =>
      installLiveTyrian({ repoRoot: repositoryRoot, home, apply: false, target: 'plasma' })
    ).toThrow('repository and install root must not overlap');
    expect(fs.readFileSync(packagePath, 'utf8')).toBe(originalPackage);
    expect(fs.existsSync(path.join(repositoryRoot, 'tyrian-night'))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live installer rejects a staging-container symlink before descendant writes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-stage-home-'));
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-stage-external-'));
  const stagingRoot = path.join(home, '.local/share/tyrian-night-stage');

  try {
    fs.mkdirSync(path.dirname(stagingRoot), { recursive: true });
    fs.writeFileSync(path.join(externalRoot, 'sentinel'), 'unchanged\n');
    fs.symlinkSync(externalRoot, stagingRoot);

    expect(() =>
      installLiveTyrian({
        repoRoot: process.cwd(),
        home,
        apply: true,
        stagingRoot,
        target: 'plasma',
      })
    ).toThrow('must be an absent path or ordinary directory');
    expect(fs.readFileSync(path.join(externalRoot, 'sentinel'), 'utf8')).toBe('unchanged\n');
    expect(fs.existsSync(path.join(home, TYRIAN_INSTALL_HOME))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test('live ownership manifest removes catalog outputs and preserves unrelated themes', () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-catalog-repo-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-catalog-home-'));

  try {
    copyLiveInstallRepoFixture(repositoryRoot);
    installLiveTyrian({ repoRoot: repositoryRoot, home, apply: true, target: 'plasma' });
    const ghosttyAbyss = path.join(home, '.config/ghostty/themes/tyrian-abyss');
    const footAbyss = path.join(home, '.config/foot/themes/tyrian-abyss.ini');
    const unrelatedGhostty = path.join(home, '.config/ghostty/themes/custom-user-theme');
    const recreatedLegacyPath = path.join(home, '.config/environment.d/tyrian-union.conf');
    fs.writeFileSync(unrelatedGhostty, 'keep\n');
    fs.mkdirSync(path.dirname(recreatedLegacyPath), { recursive: true });
    fs.writeFileSync(recreatedLegacyPath, 'keep legacy name\n');
    expect(fs.existsSync(ghosttyAbyss)).toBe(true);
    expect(fs.existsSync(footAbyss)).toBe(true);

    const catalogPath = path.join(repositoryRoot, 'source/themeCatalog.json');
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as Array<{ slug: string }>;
    fs.writeFileSync(
      catalogPath,
      `${JSON.stringify(
        catalog.filter(({ slug }) => slug !== 'tyrian-abyss'),
        null,
        2
      )}\n`
    );
    fs.rmSync(path.join(repositoryRoot, 'source/themes/tyrian-abyss.json'));
    prepareLiveInstallRepository(repositoryRoot, { home, target: 'plasma' });
    installLiveTyrian({ repoRoot: repositoryRoot, home, apply: true, target: 'plasma' });

    expect(fs.existsSync(ghosttyAbyss)).toBe(false);
    expect(fs.existsSync(footAbyss)).toBe(false);
    expect(fs.readFileSync(unrelatedGhostty, 'utf8')).toBe('keep\n');
    expect(fs.readFileSync(recreatedLegacyPath, 'utf8')).toBe('keep legacy name\n');

    fs.rmSync(path.join(home, '.local/state/tyrian-night/live-owned-paths.json'));
    fs.writeFileSync(ghosttyAbyss, 'user recreated after migration\n');
    fs.writeFileSync(footAbyss, 'user recreated after migration\n');
    installLiveTyrian({ repoRoot: repositoryRoot, home, apply: true, target: 'plasma' });

    expect(fs.readFileSync(ghosttyAbyss, 'utf8')).toBe('user recreated after migration\n');
    expect(fs.readFileSync(footAbyss, 'utf8')).toBe('user recreated after migration\n');
    expect(fs.readFileSync(recreatedLegacyPath, 'utf8')).toBe('keep legacy name\n');
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live installer rejects recursive source symlinks before mutation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-source-link-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-source-link-repo-'));
  const linkedAsset = path.join(
    root,
    'desktop/kde/plasma/desktoptheme/TyrianNight/dialogs/background.svg'
  );
  const liveConfig = path.join(home, '.config/ghostty/config');

  try {
    copyLiveInstallRepoFixture(root);
    fs.rmSync(linkedAsset);
    fs.symlinkSync(path.join(process.cwd(), 'assets/wallpaper-tyrian.png'), linkedAsset);
    fs.mkdirSync(path.dirname(liveConfig), { recursive: true });
    fs.writeFileSync(liveConfig, 'keep=true\n');

    expect(() =>
      installLiveTyrian({
        repoRoot: root,
        home,
        apply: true,
        target: 'plasma',
      })
    ).toThrow('must not be a symbolic link');
    expect(fs.readFileSync(liveConfig, 'utf8')).toBe('keep=true\n');
    expect(fs.existsSync(path.join(home, TYRIAN_BACKUP_HOME))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live installer restores exact filesystem state when a late write fails', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-rollback-home-'));
  const installMarker = path.join(home, TYRIAN_INSTALL_HOME, 'existing.txt');
  const liveConfig = path.join(home, '.config/ghostty/config');
  const externalConfig = path.join(home, 'external-ghostty.conf');
  const legacyConfig = path.join(home, '.local/share/caelestia/fish/config.fish');
  const caelestiaSchemeState = path.join(home, '.local/state/caelestia/scheme.json');

  try {
    for (const filePath of [installMarker, legacyConfig]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `original:${path.basename(filePath)}\n`);
    }
    fs.writeFileSync(externalConfig, 'external config must remain untouched\n');
    fs.mkdirSync(path.dirname(liveConfig), { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(liveConfig), externalConfig), liveConfig);

    const originalRename = fs.renameSync;
    let liveConfigPublicationObserved = false;
    let lateFailureInjected = false;
    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      const destination = resolveMutationPath(newPath);
      if (!liveConfigPublicationObserved && destination === liveConfig) {
        expect(fs.lstatSync(liveConfig).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(oldPath, 'utf8')).toContain('theme = dark:');
        liveConfigPublicationObserved = true;
        const result = originalRename(oldPath, newPath);
        expect(fs.lstatSync(liveConfig).isFile()).toBe(true);
        expect(fs.readFileSync(externalConfig, 'utf8')).toBe(
          'external config must remain untouched\n'
        );
        return result;
      }
      if (!lateFailureInjected && destination === caelestiaSchemeState) {
        lateFailureInjected = true;
        throw new Error('injected late Caelestia publication failure');
      }
      return originalRename(oldPath, newPath);
    }) as typeof fs.renameSync;

    try {
      expect(() =>
        installLiveTyrian({
          repoRoot: process.cwd(),
          home,
          apply: true,
          target: 'caelestia',
          hyprlandMode: 'legacy',
        })
      ).toThrow('injected late Caelestia publication failure');
    } finally {
      fs.renameSync = originalRename;
    }
    expect(liveConfigPublicationObserved).toBe(true);
    expect(lateFailureInjected).toBe(true);
    expect(fs.readFileSync(installMarker, 'utf8')).toBe('original:existing.txt\n');
    expect(fs.lstatSync(liveConfig).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(liveConfig)).toBe(externalConfig);
    expect(fs.readFileSync(externalConfig, 'utf8')).toBe('external config must remain untouched\n');
    expect(fs.readFileSync(legacyConfig, 'utf8')).toBe('original:config.fish\n');
    expect(fs.existsSync(caelestiaSchemeState)).toBe(false);
    expect(fs.existsSync(path.join(home, '.config/foot/foot.ini'))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('link transaction restores materialized assets when a later target write fails', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-link-scope-home-'));
  const materializedTarget = path.join(home, TYRIAN_INSTALL_HOME, 'assets/tyrian-fetch.webp');
  const lateTarget = path.join(home, '.local/state/caelestia/scheme.json');
  const originalRename = fs.renameSync;
  const originalGeneration = Buffer.from('original external materialized generation\n');
  let lateFailureInjected = false;

  try {
    fs.mkdirSync(path.dirname(materializedTarget), { recursive: true });
    fs.writeFileSync(materializedTarget, originalGeneration);
    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (!lateFailureInjected && resolveMutationPath(newPath) === lateTarget) {
        lateFailureInjected = true;
        expect(fs.readFileSync(materializedTarget)).not.toEqual(originalGeneration);
        throw new Error('injected post-materialization failure');
      }

      return originalRename(oldPath, newPath);
    }) as typeof fs.renameSync;

    expect(() =>
      installLiveTyrian({
        repoRoot: process.cwd(),
        home,
        apply: true,
        link: true,
        target: 'caelestia',
        hyprlandMode: 'legacy',
      })
    ).toThrow('injected post-materialization failure');
    expect(lateFailureInjected).toBe(true);
    expect(fs.readFileSync(materializedTarget)).toEqual(originalGeneration);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live installer rollback restores owned leaves without claiming their parent directories', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-absence-home-'));
  const lateTarget = path.join(home, '.local/state/caelestia/scheme.json');
  const ownedLeaves = [
    path.join(home, '.config/ghostty/config'),
    path.join(home, '.config/foot/foot.ini'),
    path.join(home, '.config/fish/conf.d/tyrian-night.fish'),
  ];
  const originalRename = fs.renameSync;
  let lateFailureInjected = false;

  try {
    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (!lateFailureInjected && resolveMutationPath(newPath) === lateTarget) {
        lateFailureInjected = true;
        for (const ownedLeaf of ownedLeaves) {
          expect(fs.existsSync(ownedLeaf)).toBe(true);
        }
        throw new Error('injected late Caelestia failure');
      }

      return originalRename(oldPath, newPath);
    }) as typeof fs.renameSync;

    expect(() =>
      installLiveTyrian({
        repoRoot: process.cwd(),
        home,
        apply: true,
        target: 'caelestia',
        hyprlandMode: 'legacy',
      })
    ).toThrow('injected late Caelestia failure');

    expect(lateFailureInjected).toBe(true);
    expect(fs.existsSync(path.join(home, '.config'))).toBe(true);
    for (const ownedLeaf of ownedLeaves) {
      expect(fs.existsSync(ownedLeaf)).toBe(false);
    }
    expect(fs.existsSync(path.join(home, TYRIAN_INSTALL_HOME))).toBe(false);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live installer normalizes link sources to absolute physical paths', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-link-home-'));
  const aliasRoot = path.join(os.tmpdir(), `tyrian-live-repo-alias-${process.pid}`);

  try {
    fs.rmSync(aliasRoot, { force: true });
    fs.symlinkSync(process.cwd(), aliasRoot);
    installLiveTyrian({
      repoRoot: aliasRoot,
      home,
      apply: true,
      link: true,
      target: 'plasma',
    });

    const linkedTheme = path.join(home, '.config/ghostty/themes/tyrian-nocturne');
    const lookAndFeel = path.join(home, '.local/share/plasma/look-and-feel/TyrianNight');
    expect(path.isAbsolute(fs.readlinkSync(linkedTheme))).toBe(true);
    expect(fs.realpathSync(linkedTheme)).toBe(
      fs.realpathSync(path.join(process.cwd(), 'terminal/ghostty/themes/tyrian-nocturne'))
    );
    expect(fs.lstatSync(lookAndFeel).isDirectory()).toBe(true);
    expect(fs.lstatSync(lookAndFeel).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(home, '.local/state/caelestia/scheme.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.config/hypr/scheme/current.conf'))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(aliasRoot, { force: true });
  }
});

test('live recovery is explicit after a process interruption', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-process-recovery-'));
  const liveConfig = path.join(home, '.config/ghostty/config');
  const installMarker = path.join(home, TYRIAN_INSTALL_HOME, 'original.txt');
  const transactionPath = path.join(
    home,
    '.local/state/tyrian-night/live-install-transaction.json'
  );

  try {
    fs.mkdirSync(path.dirname(liveConfig), { recursive: true });
    fs.writeFileSync(liveConfig, 'original live config\n');
    fs.mkdirSync(path.dirname(installMarker), { recursive: true });
    fs.writeFileSync(installMarker, 'original install root\n');

    expect(() =>
      installLiveTyrian({
        repoRoot: process.cwd(),
        home,
        apply: true,
        testInterruptAfterMutation: true,
        target: 'plasma',
      })
    ).toThrow('Simulated interruption');
    expect(fs.existsSync(transactionPath)).toBe(true);
    expect(fs.existsSync(installMarker)).toBe(false);
    const interruptedState = snapshotTree(home);

    installLiveTyrian({ repoRoot: process.cwd(), home, apply: false, target: 'plasma' });

    expect(snapshotTree(home)).toEqual(interruptedState);

    expect(recoverLiveTyrian({ home })).toBe('rolledBack');

    expect(fs.readFileSync(liveConfig, 'utf8')).toBe('original live config\n');
    expect(fs.readFileSync(installMarker, 'utf8')).toBe('original install root\n');
    expect(fs.existsSync(transactionPath)).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live install rolls back immediately when the committed phase cannot be recorded', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-commit-failure-'));
  const liveConfig = path.join(home, '.config/ghostty/config');
  const transactionPath = path.join(
    home,
    '.local/state/tyrian-night/live-install-transaction.json'
  );

  try {
    fs.mkdirSync(path.dirname(liveConfig), { recursive: true });
    fs.writeFileSync(liveConfig, 'original live config\n');

    expect(() =>
      installLiveTyrian({
        repoRoot: process.cwd(),
        home,
        apply: true,
        testFailCommit: true,
        target: 'plasma',
      })
    ).toThrow('Simulated live commit write failure');
    expect(fs.readFileSync(liveConfig, 'utf8')).toBe('original live config\n');
    expect(fs.existsSync(path.join(home, TYRIAN_INSTALL_HOME))).toBe(false);
    expect(fs.existsSync(transactionPath)).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('nested home transactions reject targets outside the outer owned set', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-nested-owner-'));
  const ownedPath = path.join(home, '.config/owned.conf');
  const outsidePath = path.join(home, '.config/outside.conf');
  const transactionPath = path.join(
    home,
    '.local/state/tyrian-night/live-install-transaction.json'
  );

  try {
    fs.mkdirSync(path.dirname(ownedPath), { recursive: true });
    fs.writeFileSync(ownedPath, 'original\n');
    let nestedActionRan = false;

    expect(() =>
      withHomeFilesystemTransaction(
        home,
        {
          targetPaths: [ownedPath],
          backupRoot: path.join(
            home,
            '.local/state/tyrian-night/backups/live-tyrian-apply-nested-owner'
          ),
          owner: 'live',
        },
        () =>
          withHomeFilesystemTransaction(
            home,
            {
              targetPaths: [outsidePath],
              backupRoot: path.join(
                home,
                '.local/state/tyrian-night/backups/live-tyrian-apply-nested-child'
              ),
              owner: 'live',
            },
            () => {
              nestedActionRan = true;
            }
          )
      )
    ).toThrow('Nested home transaction target is outside its owner');
    expect(nestedActionRan).toBe(false);
    expect(fs.readFileSync(ownedPath, 'utf8')).toBe('original\n');
    expect(fs.existsSync(outsidePath)).toBe(false);
    expect(fs.existsSync(transactionPath)).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('durable path sync flushes every directory entry in a newly created chain', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-durable-chain-'));
  const nestedDirectory = path.join(root, 'one/two/three');
  const nestedFile = path.join(nestedDirectory, 'state.json');
  const syncedDirectories = new Set<string>();
  const originalFsync = fs.fsyncSync;

  try {
    fs.mkdirSync(nestedDirectory, { recursive: true });
    fs.writeFileSync(nestedFile, '{}\n');
    fs.fsyncSync = (descriptor) => {
      const descriptorPath = fs.readlinkSync(`/proc/self/fd/${descriptor}`);

      if (fs.statSync(descriptorPath).isDirectory()) {
        syncedDirectories.add(fs.realpathSync(descriptorPath));
      }

      originalFsync(descriptor);
    };

    syncPathsDurably([nestedDirectory, nestedFile]);

    for (const directory of [nestedDirectory, path.dirname(nestedDirectory), root]) {
      expect(syncedDirectories).toContain(fs.realpathSync(directory));
    }
  } finally {
    fs.fsyncSync = originalFsync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live preview observes an unfinished Plasma lifecycle while apply refuses to bypass it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-plasma-journal-'));
  const journalPath = path.join(home, '.local/state/tyrian-night/plasma-lifecycle.json');

  try {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(
      journalPath,
      `${JSON.stringify({ version: 1, owner: 'layout', initiallyActive: true })}\n`
    );
    const interruptedState = snapshotTree(home);

    installLiveTyrian({ repoRoot: process.cwd(), home, apply: false, target: 'plasma' });
    expect(snapshotTree(home)).toEqual(interruptedState);

    expect(() =>
      installLiveTyrian({ repoRoot: process.cwd(), home, apply: true, target: 'plasma' })
    ).toThrow('requires recovery through the rice command');
    expect(snapshotTree(home)).toEqual(interruptedState);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('token lock publishes a complete owner and recovers its dead generation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-token-lock-dead-'));
  const lockPath = path.join(root, 'owner.lock');

  try {
    await leaveDeadTokenLock(lockPath);
    const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    expect([1, 2]).toContain(owner.version);
    expect(owner).toMatchObject({ pid: expect.any(Number), token: expect.any(String) });
    let entered = false;

    withTokenFileLock(
      lockPath,
      () => {
        entered = true;
      },
      { ownerRoot: root }
    );

    expect(entered).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('token lock reaper never unlinks a replacement generation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-token-lock-aba-'));
  const lockPath = path.join(root, 'owner.lock');
  const replacementToken = 'replacement-generation';
  const replacementOwner = `${path.basename(lockPath)}.owner-${replacementToken}.json`;

  try {
    await leaveDeadTokenLock(lockPath);

    expect(() =>
      withTokenFileLock(lockPath, () => {}, {
        ownerRoot: root,
        timeoutMs: 50,
        testBeforeReap: () => {
          fs.rmSync(lockPath, { force: true });
          const ownerPath = path.join(root, replacementOwner);
          fs.writeFileSync(
            ownerPath,
            `${JSON.stringify({
              version: 1,
              pid: process.pid,
              token: replacementToken,
              ownerFileName: replacementOwner,
              createdAtMs: Date.now(),
            })}\n`
          );
          fs.linkSync(ownerPath, lockPath);
        },
      })
    ).toThrow('held by live process');
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token).toBe(replacementToken);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('token lock only reclaims corrupt owners after the bounded stale age', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-token-lock-corrupt-'));
  const lockPath = path.join(root, 'owner.lock');

  try {
    fs.writeFileSync(lockPath, '{ incomplete');
    expect(() =>
      withTokenFileLock(lockPath, () => {}, {
        ownerRoot: root,
        timeoutMs: 25,
        corruptStaleMs: 1_000,
      })
    ).toThrow('not-yet-stale corrupt owner');
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('{ incomplete');

    fs.utimesSync(lockPath, new Date(0), new Date(0));
    let entered = false;
    withTokenFileLock(
      lockPath,
      () => {
        entered = true;
      },
      { ownerRoot: root, corruptStaleMs: 1 }
    );
    expect(entered).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('token lock rejects pid reuse as ownership of a different process generation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-token-lock-pid-reuse-'));
  const lockPath = path.join(root, 'owner.lock');
  const token = 'reused-live-pid';
  const ownerFileName = `${path.basename(lockPath)}.owner-${token}.json`;
  const ownerPath = path.join(root, ownerFileName);

  try {
    fs.writeFileSync(
      ownerPath,
      `${JSON.stringify({
        version: 2,
        pid: process.pid,
        token,
        ownerFileName,
        createdAtMs: Date.now(),
        processIdentity: 'different-boot:different-start-time',
      })}\n`
    );
    fs.linkSync(ownerPath, lockPath);
    let entered = false;

    withTokenFileLock(
      lockPath,
      () => {
        entered = true;
      },
      { ownerRoot: root }
    );

    expect(entered).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('token lock treats a symbolic-link claim as corrupt without following its target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-token-lock-link-'));
  const targetPath = path.join(root, 'unrelated.txt');
  const lockPath = path.join(root, 'owner.lock');

  try {
    fs.writeFileSync(targetPath, 'must survive\n');
    fs.symlinkSync(targetPath, lockPath);
    let entered = false;

    withTokenFileLock(
      lockPath,
      () => {
        entered = true;
      },
      { ownerRoot: root, corruptStaleMs: 0 }
    );

    expect(entered).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('must survive\n');
    expect(fs.existsSync(lockPath)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('successful action is not reported failed when lock release loses ownership', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-token-lock-release-'));
  const lockPath = path.join(root, 'owner.lock');
  const warnings: string[] = [];
  const originalWarn = console.warn;

  try {
    console.warn = (message) => warnings.push(String(message));
    const result = withTokenFileLock(lockPath, () => 42, {
      ownerRoot: root,
      testBeforeRelease: () => {
        fs.rmSync(lockPath, { force: true });
        fs.writeFileSync(lockPath, 'replacement\n');
      },
    });

    expect(result).toBe(42);
    expect(warnings).toHaveLength(1);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('replacement\n');
  } finally {
    console.warn = originalWarn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('persisted snapshot recovery rejects invented targets and invalid backup generations', () => {
  for (const tamper of ['symlink-ancestor', 'wrong-type', 'invented-target'] as const) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `tyrian-snapshot-${tamper}-home-`));
    const externalRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), `tyrian-snapshot-${tamper}-external-`)
    );
    const targetPath = path.join(home, '.config/example.conf');
    const backupRoot = path.join(
      home,
      '.local/state/tyrian-night/backups/live-tyrian-apply-tamper'
    );

    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, 'original\n');
      expect(() =>
        withHomeFilesystemTransaction(
          home,
          {
            targetPaths: [targetPath],
            backupRoot,
            owner: 'live',
            shouldLeavePrepared: () => true,
          },
          () => {
            fs.writeFileSync(targetPath, 'mutated\n');
            throw new Error('interrupt');
          }
        )
      ).toThrow('interrupt');

      const backupEntry = path.join(backupRoot, 'snapshot/0');
      if (tamper === 'symlink-ancestor') {
        const externalSnapshot = path.join(externalRoot, 'snapshot');
        fs.renameSync(path.dirname(backupEntry), externalSnapshot);
        fs.symlinkSync(externalSnapshot, path.dirname(backupEntry));
      } else {
        if (tamper === 'wrong-type') {
          fs.rmSync(backupEntry, { force: true });
          fs.mkdirSync(backupEntry);
        } else {
          const unrelatedPath = path.join(home, '.config/unrelated.conf');
          fs.writeFileSync(unrelatedPath, 'must survive\n');
          const manifestPath = path.join(backupRoot, 'snapshot.json');
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          manifest.entries[0].targetPath = unrelatedPath;
          manifest.entries[0].backupPath = 'snapshot.json';
          fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
        }
      }

      expect(() => recoverHomeFilesystemTransaction(home)).toThrow(
        tamper === 'symlink-ancestor'
          ? 'traverses a symbolic link'
          : tamper === 'wrong-type'
            ? 'backup type changed'
            : 'snapshot manifest escapes its allowed roots'
      );
      expect(fs.readFileSync(targetPath, 'utf8')).toBe('mutated\n');
      if (tamper === 'invented-target') {
        expect(fs.readFileSync(path.join(home, '.config/unrelated.conf'), 'utf8')).toBe(
          'must survive\n'
        );
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(externalRoot, { recursive: true, force: true });
    }
  }
});

test('preview does not acquire or wait for the destination mutation lock', async () => {
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-home-lock-repo-a-'));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-home-lock-repo-b-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-home-lock-destination-'));
  const readyPath = path.join(home, 'holder-ready');
  let holder: ReturnType<typeof Bun.spawn> | undefined;

  try {
    copyLiveInstallRepoFixture(repoA);
    copyLiveInstallRepoFixture(repoB);
    holder = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        [
          "import fs from 'node:fs';",
          "const module = await import('./scripts/installLiveTyrian.mjs');",
          "module.buildLiveInstallPlan({ repoRoot: process.env.REPO_A, home: process.env.HOME_ROOT, target: 'plasma' });",
          'module.withLiveInstallLock(process.env.HOME_ROOT, () => {',
          "fs.writeFileSync(process.env.READY_PATH, 'ready');",
          'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);',
          '});',
        ].join(' '),
      ],
      env: {
        ...process.env,
        REPO_A: repoA,
        HOME_ROOT: home,
        READY_PATH: readyPath,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    const deadline = Date.now() + 1_000;

    while (!fs.existsSync(readyPath) && Date.now() < deadline) {
      await Bun.sleep(5);
    }

    expect(fs.existsSync(readyPath)).toBe(true);
    installLiveTyrian({ repoRoot: repoB, home, apply: false, target: 'plasma' });
    expect(fs.existsSync(path.join(home, '.tyrian-night-live-install.lock'))).toBe(true);
    holder.kill();
    await holder.exited;
    holder = undefined;
  } finally {
    holder?.kill();
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live apply serializes against another repository copy targeting the same home', async () => {
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-home-apply-lock-repo-a-'));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-home-apply-lock-repo-b-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-home-apply-lock-destination-'));
  const readyPath = path.join(home, 'holder-ready');
  let holder: ReturnType<typeof Bun.spawn> | undefined;

  try {
    copyLiveInstallRepoFixture(repoA);
    copyLiveInstallRepoFixture(repoB);
    holder = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        [
          "import fs from 'node:fs';",
          "const module = await import('./scripts/installLiveTyrian.mjs');",
          "module.buildLiveInstallPlan({ repoRoot: process.env.REPO_A, home: process.env.HOME_ROOT, target: 'plasma' });",
          'module.withLiveInstallLock(process.env.HOME_ROOT, () => {',
          "fs.writeFileSync(process.env.READY_PATH, 'ready');",
          'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);',
          '});',
        ].join(' '),
      ],
      env: {
        ...process.env,
        REPO_A: repoA,
        HOME_ROOT: home,
        READY_PATH: readyPath,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    const deadline = Date.now() + 1_000;

    while (!fs.existsSync(readyPath) && Date.now() < deadline) {
      await Bun.sleep(5);
    }

    expect(fs.existsSync(readyPath)).toBe(true);
    const startedAt = Date.now();
    installLiveTyrian({ repoRoot: repoB, home, apply: true, target: 'plasma' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    await holder.exited;
  } finally {
    holder?.kill();
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live installer aborts on snapshot failure before changing owned paths', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-backup-failure-home-'));
  const liveConfig = path.join(home, '.config/ghostty/config');
  const backupParent = path.join(home, TYRIAN_BACKUP_HOME);

  try {
    fs.mkdirSync(path.dirname(liveConfig), { recursive: true });
    fs.writeFileSync(liveConfig, 'keep=true\n');
    fs.mkdirSync(path.dirname(backupParent), { recursive: true });
    fs.writeFileSync(backupParent, 'blocks backup directories\n');

    expect(() =>
      installLiveTyrian({
        repoRoot: process.cwd(),
        home,
        apply: true,
        target: 'plasma',
      })
    ).toThrow();
    expect(fs.readFileSync(liveConfig, 'utf8')).toBe('keep=true\n');
    expect(fs.existsSync(path.join(home, TYRIAN_INSTALL_HOME))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live transaction publishes allocating ownership before backup allocation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-allocation-owner-'));
  const backupParent = path.join(home, TYRIAN_BACKUP_HOME);
  const transactionPath = path.join(
    home,
    '.local/state/tyrian-night/live-install-transaction.json'
  );
  const originalMkdir = fs.mkdirSync;
  let ownershipObserved = false;

  try {
    fs.mkdirSync = ((directoryPath: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      const physicalPath = resolveMutationPath(directoryPath);

      if (
        !ownershipObserved &&
        path.dirname(physicalPath) === backupParent &&
        path.basename(physicalPath).startsWith('live-tyrian-apply-')
      ) {
        ownershipObserved = true;
        expect(JSON.parse(fs.readFileSync(transactionPath, 'utf8'))).toMatchObject({
          version: 3,
          owner: 'live',
          phase: 'allocating',
        });
        throw new Error('injected backup allocation failure');
      }

      return originalMkdir(directoryPath, options as fs.MakeDirectoryOptions);
    }) as typeof fs.mkdirSync;

    expect(() =>
      installLiveTyrian({ repoRoot: process.cwd(), home, apply: true, target: 'plasma' })
    ).toThrow('injected backup allocation failure');
    expect(ownershipObserved).toBe(true);
    expect(fs.existsSync(transactionPath)).toBe(false);
    expect(fs.existsSync(path.join(home, TYRIAN_INSTALL_HOME))).toBe(false);
  } finally {
    fs.mkdirSync = originalMkdir;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live transaction rejects missing directory exchange before pointer or target mutation', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-exchange-preflight-'));
  const fakeBin = path.join(home, 'fake-bin');
  const transactionPath = path.join(
    home,
    '.local/state/tyrian-night/live-install-transaction.json'
  );

  try {
    fs.mkdirSync(fakeBin);
    const fakeMv = path.join(fakeBin, 'mv');
    fs.writeFileSync(fakeMv, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeMv, 0o755);
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        [
          "const module = await import('./scripts/installLiveTyrian.mjs');",
          'try {',
          "  module.installLiveTyrian({ repoRoot: process.env.REPO_ROOT, home: process.env.HOME_ROOT, apply: true, target: 'plasma' });",
          '  process.exit(2);',
          '} catch (error) {',
          '  if (!String(error).includes("mv --exchange is unavailable")) process.exit(3);',
          '}',
        ].join(' '),
      ],
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: fakeBin,
        REPO_ROOT: process.cwd(),
        HOME_ROOT: home,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    expect(await child.exited).toBe(0);
    expect(fs.existsSync(transactionPath)).toBe(false);
    expect(fs.existsSync(path.join(home, TYRIAN_BACKUP_HOME))).toBe(false);
    expect(fs.existsSync(path.join(home, TYRIAN_INSTALL_HOME))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('command discovery requires a regular file executable by the current process', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-command-permission-'));
  const candidate = path.join(root, 'candidate');

  try {
    fs.writeFileSync(candidate, '#!/bin/sh\n');
    fs.chmodSync(candidate, 0o644);
    expect(isExecutable(candidate)).toBe(false);
    fs.chmodSync(candidate, 0o755);
    expect(isExecutable(candidate)).toBe(true);
    expect(isExecutable(root)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lock screen wallpaper patch preserves existing screen locker settings', () => {
  const patched = patchIniSection(
    [
      '[Daemon]',
      'Timeout=15',
      '',
      '[Greeter][Wallpaper][org.kde.image][General]',
      'Image=/old/wallpaper.png',
      'PreviewImage=/old/wallpaper.png',
      '',
    ].join('\n'),
    'Greeter][Wallpaper][org.kde.image][General',
    {
      Image: `${FIXTURE_HOME}/.local/share/tyrian-night/assets/wallpaper-tyrian.png`,
      PreviewImage: `${FIXTURE_HOME}/.local/share/tyrian-night/assets/wallpaper-tyrian.png`,
    }
  );

  expect(patched).toContain('[Daemon]\nTimeout=15');
  expect(patched).toContain(
    `[Greeter][Wallpaper][org.kde.image][General]\nImage=${FIXTURE_HOME}/.local/share/tyrian-night/assets/wallpaper-tyrian.png\nPreviewImage=${FIXTURE_HOME}/.local/share/tyrian-night/assets/wallpaper-tyrian.png`
  );
  expect(patched).not.toContain('/old/wallpaper.png');
});

async function leaveDeadTokenLock(lockPath: string): Promise<void> {
  const holder = Bun.spawn({
    cmd: [
      process.execPath,
      '-e',
      [
        "const module = await import('./scripts/installOps.mjs');",
        'module.withTokenFileLock(process.env.LOCK_PATH, () => process.exit(0), { ownerRoot: process.env.OWNER_ROOT });',
      ].join(' '),
    ],
    env: { ...process.env, LOCK_PATH: lockPath, OWNER_ROOT: path.dirname(lockPath) },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  expect(await holder.exited).toBe(0);
  expect(fs.existsSync(lockPath)).toBe(true);
}

function copyLiveInstallRepoFixture(targetRoot: string): void {
  const sourceRoot = process.cwd();
  const sourcePlan = buildLiveInstallPlan({
    repoRoot: sourceRoot,
    home: FIXTURE_HOME,
    target: 'plasma',
  });

  copyWorkspaceManifests(targetRoot);

  for (const { source } of sourcePlan.materializedRoots) {
    const target = path.join(targetRoot, path.relative(sourceRoot, source));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }

  fs.cpSync(path.join(sourceRoot, 'source'), path.join(targetRoot, 'source'), {
    recursive: true,
  });
}

function copyWorkspaceManifests(targetRoot: string): void {
  for (const relativePath of ['package.json', 'apps/desktop/package.json']) {
    const targetPath = path.join(targetRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(relativePath, targetPath);
  }
}

function snapshotTree(root: string): Array<[string, string]> {
  const snapshot: Array<[string, string]> = [];

  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath);

      if (entry.isDirectory()) {
        snapshot.push([relativePath, 'directory']);
        visit(absolutePath);
      } else if (entry.isSymbolicLink()) {
        snapshot.push([relativePath, `symlink:${fs.readlinkSync(absolutePath)}`]);
      } else {
        snapshot.push([relativePath, `file:${fs.readFileSync(absolutePath).toString('base64')}`]);
      }
    }
  };

  visit(root);
  return snapshot;
}
