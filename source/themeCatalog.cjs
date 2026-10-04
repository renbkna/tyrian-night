/** @type {import('../scripts/themeSources.mjs', { with: { 'resolution-mode': 'import' } }).ThemeCatalogEntry[]} */
const themeCatalog = [
  {
    slug: 'tyrian-night',
    islandEffects: 'neutral-dark',
  },
  {
    slug: 'tyrian-nocturne',
    islandEffects: 'neutral-dark',
  },
  {
    slug: 'tyrian-pastel',
    islandEffects: 'pastel',
  },
  {
    slug: 'tyrian-abyss',
    terminalDefault: true,
    islandEffects: 'abyss',
  },
  {
    slug: 'tyrian-dawn',
    terminalDefault: true,
    islandEffects: 'dawn',
  },
];

module.exports = themeCatalog;
