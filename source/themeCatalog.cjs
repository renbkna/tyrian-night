/** @type {import('../scripts/themeSources.mjs', { with: { 'resolution-mode': 'import' } }).ThemeCatalogEntry[]} */
const themeCatalog = [
  {
    slug: 'tyrian-night',
    islandEffects: 'neutral-dark',
  },
  {
    slug: 'tyrian-nocturne',
    terminalDefault: true,
    islandEffects: 'neutral-dark',
  },
  {
    slug: 'tyrian-pastel',
    islandEffects: 'pastel',
  },
  {
    slug: 'tyrian-abyss',
    islandEffects: 'abyss',
  },
  {
    slug: 'tyrian-dawn',
    terminalDefault: true,
    islandEffects: 'dawn',
  },
  {
    slug: 'tyrian-night-old',
    islandEffects: 'neutral-dark',
  },
];

module.exports = themeCatalog;
