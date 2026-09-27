import { readSourceData, writeSourceData } from '../support/sourceData.js';
import { THEME_REPOSITORY } from '../support/themes.js';
import { expect, setDefaultTimeout, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { oklchToHex } from '../../scripts/colorScience.mjs';
import { isExecutable } from '../../apps/desktop/src/commandChecks.mjs';
import {
  buildLiveInstallPlan,
  installLiveTyrian,
  LIVE_INSTALL_OWNERSHIP_RELATIVE_PATH,
  patchIniSection,
  prepareLiveInstallRepository,
  recoverLiveTyrian,
} from '../../apps/desktop/src/installLiveTyrian.mjs';
import { exists } from '../../apps/desktop/src/installOps.mjs';
import {
  TYRIAN_BACKUP_HOME,
  TYRIAN_INSTALL_HOME,
  WALLPAPER_ASSET_PATH,
} from '../../apps/desktop/src/installPaths.mjs';
import {
  buildFishStartupConfig,
  buildFootConfig,
  buildGhosttyConfig,
} from '../../scripts/terminalThemes.mjs';
import { loadThemeDefinitionContext } from '../../scripts/themeDefinition.mjs';

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
    expect(fs.existsSync(path.join(root, 'desktop/kde/color-schemes/TyrianNocturne.colors'))).toBe(
      true
    );
    expect(
      fs.existsSync(
        path.join(root, 'desktop/kde/plasma/look-and-feel/TyrianNocturne/contents/defaults')
      )
    ).toBe(true);
    expect(
      fs.existsSync(path.join(root, 'desktop/caelestia/state/tyrian-nocturne.scheme.json'))
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
    expect(fs.existsSync(path.join(home, '.local/state/tyrian-night/desktop.lock'))).toBe(false);
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
  const installRoot = `${FIXTURE_HOME}/${TYRIAN_INSTALL_HOME}`;

  expect(plan.mode).toBe('copy');
  expect(plan.installRoot).toBe(installRoot);
  expect(plan.sourceRoot).toBe(installRoot);
  expect(plan.materializedRoots).toContainEqual({
    source: path.join(repoRoot, 'assets/tyrian-fetch.webp'),
    target: `${installRoot}/assets/tyrian-fetch.webp`,
  });
  expect(plan.materializedRoots).toContainEqual({
    source: path.join(repoRoot, 'terminal/foot/themes/tyrian-nocturne.ini'),
    target: `${installRoot}/terminal/foot/themes/tyrian-nocturne.ini`,
  });
  expect(plan.materializedRoots).toContainEqual({
    source: path.join(repoRoot, 'desktop/kde/plasma/desktoptheme/TyrianNocturne'),
    target: `${installRoot}/desktop/kde/plasma/desktoptheme/TyrianNocturne`,
  });
  expect(plan.desktopThemeId).toBe('TyrianNocturne');
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
  expect(JSON.stringify(plan.sourcePaths)).not.toContain(repoRoot);
});

test('live desktop selection follows the injected family canonical theme across every projection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-default-repo-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    selectFamilyCanonical(root, 'tyrian-abyss');

    const plan = buildLiveInstallPlan({
      repoRoot: root,
      home: FIXTURE_HOME,
      target: 'caelestia',
      hyprlandMode: 'legacy',
    });

    expect(plan.desktopThemeId).toBe('TyrianAbyss');
    expect(plan.materializedPaths).toEqual(
      expect.arrayContaining([
        'desktop/kde/color-schemes/TyrianAbyss.colors',
        'desktop/kde/plasma/desktoptheme/TyrianAbyss',
        'desktop/kde/plasma/look-and-feel/TyrianAbyss',
        'desktop/caelestia/state/tyrian-abyss.scheme.json',
        'desktop/caelestia/hypr/tyrian-abyss.conf',
        'desktop/caelestia/hypr/tyrian-abyss.lua',
      ])
    );
    expect(plan.sourcePaths.caelestiaSchemeState).toBe(
      `${FIXTURE_HOME}/${TYRIAN_INSTALL_HOME}/desktop/caelestia/state/tyrian-abyss.scheme.json`
    );
    expect(plan.livePaths.kdeTyrianScheme).toBe(
      `${FIXTURE_HOME}/.local/share/color-schemes/TyrianAbyss.colors`
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live desktop selection removes a retired Plasma theme without touching unrelated paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-default-replacement-repo-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-default-replacement-home-'));
  const environment = {
    XDG_CONFIG_HOME: path.join(home, 'xdg/config'),
    XDG_DATA_HOME: path.join(home, 'xdg/data'),
    XDG_STATE_HOME: path.join(home, 'xdg/state'),
  };

  try {
    copyLiveInstallRepoFixture(root);
    selectFamilyCanonical(root, 'tyrian-night');
    prepareLiveInstallRepository(root, { home, target: 'plasma' });
    installLiveTyrian({
      repoRoot: root,
      home,
      environment,
      apply: true,
      target: 'plasma',
    });

    const nightAssets = [
      path.join(environment.XDG_DATA_HOME, 'color-schemes/TyrianNight.colors'),
      path.join(environment.XDG_DATA_HOME, 'plasma/desktoptheme/TyrianNight'),
      path.join(environment.XDG_DATA_HOME, 'plasma/look-and-feel/TyrianNight'),
    ];
    const nocturneAssets = [
      path.join(environment.XDG_DATA_HOME, 'color-schemes/TyrianNocturne.colors'),
      path.join(environment.XDG_DATA_HOME, 'plasma/desktoptheme/TyrianNocturne'),
      path.join(environment.XDG_DATA_HOME, 'plasma/look-and-feel/TyrianNocturne'),
    ];
    const unrelatedScheme = path.join(environment.XDG_DATA_HOME, 'color-schemes/CustomUser.colors');
    const unrelatedDesktopTheme = path.join(
      environment.XDG_DATA_HOME,
      'plasma/desktoptheme/CustomUser'
    );
    const unrelatedLookAndFeel = path.join(
      environment.XDG_DATA_HOME,
      'plasma/look-and-feel/CustomUser'
    );
    for (const nightAsset of nightAssets) {
      expect(fs.existsSync(nightAsset)).toBe(true);
    }
    const previousOwnership = JSON.parse(
      fs.readFileSync(path.join(home, LIVE_INSTALL_OWNERSHIP_RELATIVE_PATH), 'utf8')
    );
    expect(Object.keys(previousOwnership).toSorted()).toEqual(['owner', 'profiles']);
    for (const nightAsset of nightAssets) {
      expect(previousOwnership.profiles.plasma.paths).toContain(path.relative(home, nightAsset));
    }
    fs.writeFileSync(unrelatedScheme, 'user scheme\n');
    for (const unrelatedPackage of [unrelatedDesktopTheme, unrelatedLookAndFeel]) {
      fs.mkdirSync(unrelatedPackage, { recursive: true });
      fs.writeFileSync(path.join(unrelatedPackage, 'user-owned.txt'), 'user package\n');
    }

    selectFamilyCanonical(root, 'tyrian-nocturne');
    removeCatalogTheme(root, 'tyrian-night');
    prepareLiveInstallRepository(root, { home, target: 'plasma' });
    installLiveTyrian({
      repoRoot: root,
      home,
      environment,
      apply: true,
      target: 'plasma',
    });

    for (const nightAsset of nightAssets) {
      expect(fs.existsSync(nightAsset)).toBe(false);
    }
    for (const nocturneAsset of nocturneAssets) {
      expect(fs.existsSync(nocturneAsset)).toBe(true);
    }
    expect(fs.readFileSync(unrelatedScheme, 'utf8')).toBe('user scheme\n');
    for (const unrelatedPackage of [unrelatedDesktopTheme, unrelatedLookAndFeel]) {
      expect(fs.readFileSync(path.join(unrelatedPackage, 'user-owned.txt'), 'utf8')).toBe(
        'user package\n'
      );
    }
    const ownership = JSON.parse(
      fs.readFileSync(path.join(home, LIVE_INSTALL_OWNERSHIP_RELATIVE_PATH), 'utf8')
    );
    for (const nightAsset of nightAssets) {
      expect(ownership.profiles.plasma.paths).not.toContain(path.relative(home, nightAsset));
    }
    for (const nocturneAsset of nocturneAssets) {
      expect(ownership.profiles.plasma.paths).toContain(path.relative(home, nocturneAsset));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live installer materializes full Tyrian rice targets without claiming historical paths', () => {
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
    const tyrianDesktopTheme = path.join(home, '.local/share/plasma/desktoptheme/TyrianNocturne');
    const tyrianLookAndFeel = path.join(home, '.local/share/plasma/look-and-feel/TyrianNocturne');

    expect(fs.existsSync(path.join(home, '.local/share/plasma/desktoptheme/Monochrome'))).toBe(
      false
    );
    expect(fs.existsSync(path.join(tyrianDesktopTheme, 'metadata.json'))).toBe(true);
    expect(fs.existsSync(path.join(tyrianDesktopTheme, 'dialogs/background.svg'))).toBe(true);
    expect(fs.existsSync(path.join(tyrianLookAndFeel, 'contents/defaults'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.local/share/union/css/styles/TyrianNight'))).toBe(true);
    expect(
      fs.readFileSync(
        path.join(home, '.local/share/union/css/styles/TyrianNight/style.css'),
        'utf8'
      )
    ).toBe('/* stale Tyrian Union runtime */\n');
    expect(fs.readFileSync(path.join(home, '.local/share/union/user-data.txt'), 'utf8')).toBe(
      'keep\n'
    );
    expect(fs.existsSync(unionEnvironment)).toBe(false);
    expect(fs.readFileSync(legacyFishConfig, 'utf8')).toBe('echo stale legacy\n');
    expect(fs.readFileSync(legacyFishGreeting, 'utf8')).toContain('echo stale legacy');
    expect(fs.readFileSync(fishConfig, 'utf8')).toBe(
      buildFishStartupConfig({ repository: THEME_REPOSITORY, tyrianRoot: installRoot })
    );
    expect(fs.existsSync(fishTheme)).toBe(true);
    expect(fs.readFileSync(fishConfig, 'utf8')).toContain(
      'source $TYRIAN_NIGHT_ROOT/terminal/fish/themes/tyrian-nocturne.fish'
    );
    expect(fs.readFileSync(fishGreeting, 'utf8')).toContain(
      'fastfetch --config $tyrian_night_root/terminal/fastfetch/tyrian-night.jsonc'
    );
    expect(fs.readFileSync(ghosttyConfig, 'utf8')).toBe(
      buildGhosttyConfig({ repository: THEME_REPOSITORY })
    );
    expect(fs.readFileSync(ghosttyCss, 'utf8')).toBe('/* obsolete static dark chrome */\n');
    expect(fs.readFileSync(ghosttyConfig, 'utf8')).not.toContain('gtk-custom-css');
    expect(fs.readFileSync(ghosttyConfig, 'utf8')).not.toContain('window-titlebar-background');
    expect(
      fs.readFileSync(path.join(home, '.config/ghostty/themes/tyrian-dawn'), 'utf8')
    ).toContain('window-titlebar-background');
    expect(fs.readFileSync(footConfig, 'utf8')).toBe(
      buildFootConfig({ repository: THEME_REPOSITORY, themeDirectory: path.dirname(footTheme) })
    );
    expect(fs.existsSync(footTheme)).toBe(true);
    expect(fs.readFileSync(fishConfig, 'utf8')).not.toContain('custom-greeting');
    expect(fs.readFileSync(fishGreeting, 'utf8')).not.toContain('custom-greeting');
    expect(fs.readFileSync(ghosttyConfig, 'utf8')).not.toContain('font-size = 99');
    expect(fs.readFileSync(footConfig, 'utf8')).not.toContain('font=stale:size=99');
    expect(fs.readFileSync(kdeglobals, 'utf8')).toContain(
      '[KDE]\nLookAndFeelPackage=TyrianNocturne\nwidgetStyle=Breeze'
    );
    expect(fs.readFileSync(kdeglobals, 'utf8')).toContain('[General]\nColorScheme=TyrianNocturne');
    expect(fs.readFileSync(plasmarc, 'utf8')).toContain('[Theme]\nname=TyrianNocturne');
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

    expect(fs.readFileSync(plan.livePaths.hyprCurrentScheme, 'utf8')).toBe(
      fs.readFileSync('desktop/caelestia/hypr/tyrian-nocturne.lua', 'utf8')
    );
    expect(fs.readFileSync(plan.livePaths.caelestiaSchemeState, 'utf8')).toBe(
      fs.readFileSync('desktop/caelestia/state/tyrian-nocturne.scheme.json', 'utf8')
    );
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

test('fresh ownership preserves historical-looking paths without a manifest', () => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-fresh-repo-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-fresh-home-'));
  const environment = {
    XDG_CONFIG_HOME: path.join(home, 'xdg/config'),
    XDG_DATA_HOME: path.join(home, 'xdg/data'),
    XDG_STATE_HOME: path.join(home, 'xdg/state'),
  };
  const historicalPaths = [
    path.join(home, '.config/ghostty/ghostty.css'),
    path.join(home, '.config/environment.d/tyrian-union.conf'),
    path.join(home, '.local/share/union/css/styles/TyrianNight/style.css'),
    path.join(home, '.local/share/caelestia/fish/config.fish'),
    path.join(home, '.local/share/caelestia/fastfetch/config.jsonc'),
    path.join(environment.XDG_DATA_HOME, 'caelestia/starship.toml'),
  ];

  try {
    copyLiveInstallRepoFixture(repositoryRoot);
    for (const filePath of historicalPaths) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `historical:${path.relative(home, filePath)}\n`);
    }

    installLiveTyrian({
      repoRoot: repositoryRoot,
      home,
      environment,
      apply: true,
      link: true,
      target: 'plasma',
    });

    for (const filePath of historicalPaths) {
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        `historical:${path.relative(home, filePath)}\n`
      );
    }

    const ownershipManifest = JSON.parse(
      fs.readFileSync(path.join(home, LIVE_INSTALL_OWNERSHIP_RELATIVE_PATH), 'utf8')
    );
    expect(Object.keys(ownershipManifest).toSorted()).toEqual(['owner', 'profiles']);
    expect(ownershipManifest.profiles.common.roots.configRoot).toBe('xdg/config');
    expect(ownershipManifest.profiles.plasma.roots.dataRoot).toBe('xdg/data');
    const ownedPaths = Object.values(
      ownershipManifest.profiles as Record<string, { paths: string[] }>
    ).flatMap((profile) => profile.paths);
    for (const filePath of historicalPaths) {
      expect(ownedPaths).not.toContain(path.relative(home, filePath));
    }
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
  const historicalCaelestiaFastfetch = path.join(
    home,
    '.local/share/caelestia/fastfetch/config.jsonc'
  );
  const kdeglobals = path.join(home, '.config/kdeglobals');

  try {
    fs.mkdirSync(path.dirname(caelestiaState), { recursive: true });
    fs.mkdirSync(path.dirname(historicalCaelestiaFastfetch), { recursive: true });
    fs.writeFileSync(caelestiaState, 'user-owned Caelestia state\n');
    fs.writeFileSync(historicalCaelestiaFastfetch, 'historical Tyrian projection\n');

    installLiveTyrian({
      repoRoot: process.cwd(),
      home,
      apply: true,
      target: 'plasma',
    });
    expect(fs.readFileSync(caelestiaState, 'utf8')).toBe('user-owned Caelestia state\n');
    expect(fs.readFileSync(historicalCaelestiaFastfetch, 'utf8')).toBe(
      'historical Tyrian projection\n'
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
    expect(fs.readFileSync(historicalCaelestiaFastfetch, 'utf8')).toBe(
      'historical Tyrian projection\n'
    );
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
    expect(Object.keys(manifest).toSorted()).toEqual(['owner', 'profiles']);
    expect(manifest.owner).toBe('Tyrian Night live install');
    expect(Object.keys(manifest.profiles).toSorted()).toEqual(['caelestia', 'common', 'plasma']);
    expect(Array.isArray(manifest.profiles.common.paths)).toBe(true);
    expect(manifest.profiles.plasma.paths).toContain('.config/kdeglobals');
    expect(manifest.profiles.caelestia.paths).toContain('.config/hypr/scheme/current.lua');
    expect(manifest.profiles.caelestia.paths).not.toContain('.config/hypr/scheme/current.conf');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('profile ownership relocates across XDG roots without losing the unselected profile', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-xdg-relocation-'));
  const ownershipManifest = path.join(home, LIVE_INSTALL_OWNERSHIP_RELATIVE_PATH);
  const environmentA = {
    XDG_CONFIG_HOME: path.join(home, 'xdg-a/config'),
    XDG_DATA_HOME: path.join(home, 'xdg-a/data'),
    XDG_STATE_HOME: path.join(home, 'xdg-a/state'),
  };
  const environmentB = {
    XDG_CONFIG_HOME: path.join(home, 'xdg-b/config'),
    XDG_DATA_HOME: path.join(home, 'xdg-b/data'),
    XDG_STATE_HOME: path.join(home, 'xdg-b/state'),
  };

  try {
    installLiveTyrian({
      repoRoot: process.cwd(),
      home,
      environment: environmentA,
      apply: true,
      target: 'plasma',
    });
    expect(Object.keys(JSON.parse(fs.readFileSync(ownershipManifest, 'utf8'))).toSorted()).toEqual([
      'owner',
      'profiles',
    ]);

    const oldCommon = path.join(environmentA.XDG_CONFIG_HOME, 'ghostty/config');
    const oldPlasma = path.join(environmentA.XDG_CONFIG_HOME, 'kdeglobals');
    const newCommon = path.join(environmentB.XDG_CONFIG_HOME, 'ghostty/config');
    const newPlasma = path.join(environmentB.XDG_CONFIG_HOME, 'kdeglobals');
    const oldPlasmaContent = fs.readFileSync(oldPlasma, 'utf8');

    installLiveTyrian({
      repoRoot: process.cwd(),
      home,
      environment: environmentB,
      apply: true,
      target: 'caelestia',
      hyprlandMode: 'legacy',
    });

    expect(fs.existsSync(oldCommon)).toBe(false);
    expect(fs.existsSync(newCommon)).toBe(true);
    expect(fs.readFileSync(oldPlasma, 'utf8')).toBe(oldPlasmaContent);
    let ownership = JSON.parse(fs.readFileSync(ownershipManifest, 'utf8'));
    expect(Object.keys(ownership).toSorted()).toEqual(['owner', 'profiles']);
    expect(ownership.profiles.common.roots.configRoot).toBe('xdg-b/config');
    expect(ownership.profiles.plasma.roots.configRoot).toBe('xdg-a/config');
    expect(ownership.profiles.caelestia.roots.configRoot).toBe('xdg-b/config');

    installLiveTyrian({
      repoRoot: process.cwd(),
      home,
      environment: environmentB,
      apply: true,
      target: 'plasma',
    });

    expect(fs.existsSync(oldPlasma)).toBe(false);
    expect(fs.existsSync(newPlasma)).toBe(true);
    ownership = JSON.parse(fs.readFileSync(ownershipManifest, 'utf8'));
    expect(ownership.profiles.plasma.roots.configRoot).toBe('xdg-b/config');
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
    removeCatalogTheme(repoRoot, 'tyrian-abyss');
    const themePath = path.join(repoRoot, 'source/themes/tyrian-nocturne.cjs');
    const theme = readSourceData(themePath);
    theme.oklch['ui:surface.canvas'] = [0.11, 0.03];
    theme.oklch['ui:text.primary'] = [0.86, 0.02];
    writeSourceData(themePath, theme);
    const definition = loadThemeDefinitionContext(repoRoot);
    const resolvedInjectedColor = (pigment: string, L: number, C: number) => {
      const hue = definition.familyContract.pigmentHues[pigment]!.core;
      if (hue === null || hue === undefined) {
        throw new Error(`Missing test pigment hue: ${pigment}`);
      }
      return oklchToHex({
        C,
        L,
        h: hue,
      });
    };
    const injectedCanvas = resolvedInjectedColor('ui:surface.canvas', 0.11, 0.03);
    const injectedText = resolvedInjectedColor('ui:text.primary', 0.86, 0.02);
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
    expect(installedNocturne).toContain(`window-titlebar-background = ${injectedCanvas}`);
    expect(installedNocturne).toContain(`window-titlebar-foreground = ${injectedText}`);
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
    fs.rmSync(path.join(repoRoot, 'desktop/caelestia/state/tyrian-nocturne.sequences.txt'));
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

    removeCatalogTheme(repositoryRoot, 'tyrian-abyss');
    prepareLiveInstallRepository(repositoryRoot, { home, target: 'plasma' });
    installLiveTyrian({ repoRoot: repositoryRoot, home, apply: true, target: 'plasma' });

    expect(fs.existsSync(ghosttyAbyss)).toBe(false);
    expect(fs.existsSync(footAbyss)).toBe(false);
    expect(fs.readFileSync(unrelatedGhostty, 'utf8')).toBe('keep\n');
    expect(fs.readFileSync(recreatedLegacyPath, 'utf8')).toBe('keep legacy name\n');

    fs.rmSync(path.join(home, '.local/state/tyrian-night/live-owned-paths.json'));
    fs.writeFileSync(ghosttyAbyss, 'user recreated after catalog change\n');
    fs.writeFileSync(footAbyss, 'user recreated after catalog change\n');
    installLiveTyrian({ repoRoot: repositoryRoot, home, apply: true, target: 'plasma' });

    expect(fs.readFileSync(ghosttyAbyss, 'utf8')).toBe('user recreated after catalog change\n');
    expect(fs.readFileSync(footAbyss, 'utf8')).toBe('user recreated after catalog change\n');
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
    'desktop/kde/plasma/desktoptheme/TyrianNocturne/dialogs/background.svg'
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

test('a failed apply is completed by rerunning it and undone exactly by recovery', () => {
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
    expect(fs.lstatSync(liveConfig).isFile()).toBe(true);

    const rerunReceipt = installLiveTyrian({
      repoRoot: process.cwd(),
      home,
      apply: true,
      target: 'caelestia',
      hyprlandMode: 'legacy',
    });
    expect(fs.existsSync(caelestiaSchemeState)).toBe(true);
    expect(fs.existsSync(path.join(home, '.config/foot/foot.ini'))).toBe(true);

    // The rerun's backup holds the partial state; recovery undoes one step at a time.
    expect(recoverLiveTyrian({ home })).toBe(rerunReceipt?.backupRoot);
    expect(fs.existsSync(caelestiaSchemeState)).toBe(false);
    recoverLiveTyrian({ home });
    expect(recoverLiveTyrian({ home })).toBeUndefined();
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
    const lookAndFeel = path.join(home, '.local/share/plasma/look-and-feel/TyrianNocturne');
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

for (const mode of ['copy', 'link'] as const) {
  test(`live ${mode} apply killed while staging leaves the install root intact and a rerun converges`, async () => {
    const repositoryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), `tyrian-live-${mode}-crash-repo-`)
    );
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `tyrian-live-${mode}-crash-home-`));

    try {
      copyLiveInstallRepoFixture(repositoryRoot);
      const installRoot = path.join(home, TYRIAN_INSTALL_HOME);
      fs.mkdirSync(installRoot, { recursive: true });
      fs.writeFileSync(
        path.join(installRoot, 'preexisting.txt'),
        'preexisting install generation\n'
      );
      const plan = buildLiveInstallPlan({
        repoRoot: repositoryRoot,
        home,
        link: mode === 'link',
        target: 'plasma',
      });
      const [firstRoot, secondRoot] = plan.materializedRoots;
      if (!firstRoot || !secondRoot) throw new Error('Live fixture has too few materialized roots');
      const installBefore = snapshotTree(installRoot);
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          '-e',
          [
            "import fs from 'node:fs';",
            "import path from 'node:path';",
            "const module = await import('./apps/desktop/src/installLiveTyrian.mjs');",
            'const killAtSecondMaterializedRoot = (source) => {',
            '  if (path.resolve(String(source)) === process.env.KILL_SOURCE) {',
            "    process.kill(process.pid, 'SIGKILL');",
            '  }',
            '};',
            "if (process.env.INSTALL_MODE === 'copy') {",
            '  const originalCopy = fs.cpSync;',
            '  fs.cpSync = (source, destination, ...options) => {',
            '    killAtSecondMaterializedRoot(source);',
            '    return originalCopy.call(fs, source, destination, ...options);',
            '  };',
            '} else {',
            '  const originalLink = fs.symlinkSync;',
            '  fs.symlinkSync = (source, destination, ...options) => {',
            '    killAtSecondMaterializedRoot(source);',
            '    return originalLink.call(fs, source, destination, ...options);',
            '  };',
            '}',
            "module.installLiveTyrian({ repoRoot: process.env.REPOSITORY_ROOT, home: process.env.HOME_ROOT, apply: true, link: process.env.INSTALL_MODE === 'link', target: 'plasma' });",
            'process.exit(42);',
          ].join(' '),
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME_ROOT: home,
          INSTALL_MODE: mode,
          KILL_SOURCE: secondRoot.source,
          REPOSITORY_ROOT: repositoryRoot,
        },
        stdout: 'ignore',
        stderr: 'ignore',
      });

      const exitCode = await child.exited;
      expect(exitCode).not.toBe(0);
      expect(exitCode).not.toBe(42);

      const stagingRoots = fs
        .readdirSync(path.dirname(installRoot))
        .filter((name) => name.startsWith(`${path.basename(installRoot)}.stage-`));
      expect(stagingRoots).toHaveLength(1);
      const stagingRoot = path.join(path.dirname(installRoot), stagingRoots[0] ?? '');
      const firstStagedPath = path.join(
        stagingRoot,
        path.relative(plan.installRoot, firstRoot.target)
      );
      expect(fs.existsSync(firstStagedPath)).toBe(true);
      expect(snapshotTree(installRoot)).toEqual(installBefore);

      installLiveTyrian({
        repoRoot: repositoryRoot,
        home,
        apply: true,
        link: mode === 'link',
        target: 'plasma',
      });

      expect(fs.existsSync(stagingRoot)).toBe(false);
      expect(fs.existsSync(path.join(installRoot, 'preexisting.txt'))).toBe(false);
      expect(fs.existsSync(secondRoot.target)).toBe(true);

      recoverLiveTyrian({ home });
      recoverLiveTyrian({ home });
      expect(snapshotTree(installRoot)).toEqual(installBefore);
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test('live preview observes an unfinished Plasma lifecycle while apply refuses to bypass it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-plasma-journal-'));
  const journalPath = path.join(home, '.local/state/tyrian-night/plasma-lifecycle.json');

  try {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(
      journalPath,
      `${JSON.stringify({ owner: 'layout', backupRoot: path.join(home, 'backup') })}\n`
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

test('live apply rejects missing directory exchange before backup or target mutation', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-exchange-preflight-'));
  const fakeBin = path.join(home, 'fake-bin');

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
          "const module = await import('./apps/desktop/src/installLiveTyrian.mjs');",
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

function selectFamilyCanonical(repositoryRoot: string, slug: string): void {
  const familyPath = path.join(repositoryRoot, 'source/themeFamilyContract.cjs');
  const family = readSourceData(familyPath) as {
    canonical: string;
    energyLine: {
      variants: Record<
        string,
        {
          semanticChromaRatio: { maximum: number; minimum: number };
          semanticContrast: { maximum: number; minimum: number };
        }
      >;
    };
  };
  family.canonical = slug;
  for (const variant of Object.values(family.energyLine.variants)) {
    variant.semanticChromaRatio = { minimum: 0, maximum: 100 };
    variant.semanticContrast = { minimum: 1, maximum: 21 };
  }
  writeSourceData(familyPath, family);
}

function removeCatalogTheme(repositoryRoot: string, slug: string): void {
  const catalogPath = path.join(repositoryRoot, 'source/themeCatalog.cjs');
  const catalog = readSourceData(catalogPath) as Array<{ slug: string }>;
  writeSourceData(
    catalogPath,
    catalog.filter((entry) => entry.slug !== slug)
  );

  const familyPath = path.join(repositoryRoot, 'source/themeFamilyContract.cjs');
  const family = readSourceData(familyPath);
  delete family.energyLine.variants[slug];
  family.energyLine.canvasLightnessOrder = family.energyLine.canvasLightnessOrder.filter(
    (entry: string) => entry !== slug
  );
  delete family.branches[slug];
  writeSourceData(familyPath, family);
  fs.rmSync(path.join(repositoryRoot, `source/themes/${slug}.cjs`));
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
