/** @type {import('../scripts/themePigmentPolicy.mjs', { with: { 'resolution-mode': 'import' } }).ThemePigmentPolicy} */
const themePigmentPolicy = {
  reservations: [
    {
      id: 'green-cyan-reserved',
      minimum: 100,
      maximum: 205,
      allowedPigments: [
        'syntax:string',
        'terminal:ansi.brightGreen',
        'terminal:ansi.green',
        'ui:status.success',
      ],
    },
  ],
};

module.exports = themePigmentPolicy;
