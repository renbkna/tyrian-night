export const TYRIAN_THEME_CATALOG = [
  {
    label: 'Tyrian Night',
    slug: 'tyrian-night',
    isDefault: true,
    vscodeUiTheme: 'vs-dark',
    islandCssFile: 'tyrian-night.css',
    islandCssPath: 'apps/vscode/island/tyrian-night.css',
    paletteName: 'tyrian_night',
    appearance: 'dark',
  },
  {
    label: 'Tyrian Nocturne',
    slug: 'tyrian-nocturne',
    isDefault: false,
    vscodeUiTheme: 'vs-dark',
    islandCssFile: 'tyrian-nocturne.css',
    islandCssPath: 'apps/vscode/island/tyrian-nocturne.css',
    paletteName: 'tyrian_nocturne',
    appearance: 'dark',
  },
  {
    label: 'Tyrian Night Old',
    slug: 'tyrian-night-old',
    isDefault: false,
    vscodeUiTheme: 'vs-dark',
    islandCssFile: 'tyrian-night-old.css',
    islandCssPath: 'apps/vscode/island/tyrian-night-old.css',
    paletteName: 'tyrian_night_old',
    appearance: 'dark',
  },
  {
    label: 'Tyrian Abyss',
    slug: 'tyrian-abyss',
    isDefault: false,
    vscodeUiTheme: 'vs-dark',
    islandCssFile: 'tyrian-abyss.css',
    islandCssPath: 'apps/vscode/island/tyrian-abyss.css',
    paletteName: 'tyrian_abyss',
    appearance: 'dark',
  },
  {
    label: 'Tyrian Dawn',
    slug: 'tyrian-dawn',
    isDefault: false,
    vscodeUiTheme: 'vs',
    islandCssFile: 'tyrian-dawn.css',
    islandCssPath: 'apps/vscode/island/tyrian-dawn.css',
    paletteName: 'tyrian_dawn',
    appearance: 'light',
  },
] as const;

export type TyrianThemeCatalogEntry = (typeof TYRIAN_THEME_CATALOG)[number];
export type TyrianThemeLabel = TyrianThemeCatalogEntry['label'];

export const DEFAULT_TYRIAN_THEME_LABEL = 'Tyrian Night';

export const TYRIAN_THEME_CSS: Record<string, string> = Object.fromEntries(
  TYRIAN_THEME_CATALOG.map((theme) => [theme.label, theme.islandCssFile])
);

export function isTyrianThemeLabel(theme: string | undefined): theme is TyrianThemeLabel {
  return theme !== undefined && Object.hasOwn(TYRIAN_THEME_CSS, theme);
}

export function getIslandCssFileForTheme(theme: string): string | undefined {
  return TYRIAN_THEME_CSS[theme];
}
