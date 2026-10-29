export const TYRIAN_THEME_CATALOG = [
  {
    label: 'Tyrian Night',
    slug: 'tyrian-night',
    isDefault: false,
    islandCssFile: 'tyrian-night.css',
  },
  {
    label: 'Tyrian Nocturne',
    slug: 'tyrian-nocturne',
    isDefault: false,
    islandCssFile: 'tyrian-nocturne.css',
  },
  {
    label: 'Tyrian Pastel',
    slug: 'tyrian-pastel',
    isDefault: false,
    islandCssFile: 'tyrian-pastel.css',
  },
  {
    label: 'Tyrian Abyss',
    slug: 'tyrian-abyss',
    isDefault: true,
    islandCssFile: 'tyrian-abyss.css',
  },
  {
    label: 'Tyrian Dawn',
    slug: 'tyrian-dawn',
    isDefault: false,
    islandCssFile: 'tyrian-dawn.css',
  },
] as const;

export type TyrianThemeCatalogEntry = (typeof TYRIAN_THEME_CATALOG)[number];
export type TyrianThemeLabel = TyrianThemeCatalogEntry['label'];

export const DEFAULT_TYRIAN_THEME_LABEL = 'Tyrian Abyss';

export function isTyrianThemeLabel(theme: string | undefined): theme is TyrianThemeLabel {
  return theme !== undefined && TYRIAN_THEME_CATALOG.some(({ label }) => label === theme);
}

export function getIslandCssFileForTheme(theme: string): string | undefined {
  return TYRIAN_THEME_CATALOG.find(({ label }) => label === theme)?.islandCssFile;
}

export function isTyrianIslandCssFile(cssFile: string): boolean {
  return TYRIAN_THEME_CATALOG.some(({ islandCssFile }) => islandCssFile === cssFile);
}
