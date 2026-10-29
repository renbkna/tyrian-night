# Union CSS Rice Source

`index.css` is the editable Union application-style entry point. It imports the component-family files in `parts/`.

The parts follow the shared [interaction contract](../../README.md#interaction-contract). Use the
shape tokens by component scale: `--tyrian-radius-small` for indicators, `--tyrian-radius-medium`
for controls and rows, `--tyrian-radius-large` for cards, dialogs and popups, and
`--tyrian-pill-radius` for round indicators and switch tracks.

`scripts/desktopThemes.mjs` injects Tyrian palette tokens into `/* TYRIAN_GENERATED_TOKENS */` for each theme and writes generated styles under `desktop/kde/union/css/styles/*/style.css`.

Keep generated color values out of this template. Use `--tyrian-*` variables so hues continue to come from `source/themeFamilyContract.cjs`, per-variant lightness and chroma from `source/themes/`, aliases from `source/themeColorBindings.cjs`, and derived alpha from `source/themeOpacityContract.cjs`; role membership is owned by `source/themeRoleContract.cjs`.

Source CSS may use local `@import` rules. Generated KDE output is flattened and must not import Breeze, `kcolorscheme`, external paths, or runtime CSS files.
