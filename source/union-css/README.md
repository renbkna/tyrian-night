# Union CSS Rice Source

`index.css` is the editable Union application-style entry point. It imports the component-family files in `parts/`.

The state grammar is shared across component families:

- hover changes the local surface and may add a low-chroma neutral border;
- pressed uses the stronger active surface;
- checked or selected uses a persistent low-chroma selection surface;
- keyboard focus adds an outline without replacing the semantic state;
- the saturated accent is reserved for keyboard focus, primary actions, and compact indicators.

Use the three shape tokens by component scale: `--tyrian-radius-small` for indicators, `--tyrian-radius-medium` for controls and rows, and `--tyrian-radius-large` for cards, dialogs, and popups.

`scripts/desktopThemes.mjs` injects Tyrian palette tokens into `/* TYRIAN_GENERATED_TOKENS */` for each theme and writes generated styles under `desktop/kde/union/css/styles/*/style.css`.

Keep generated color values out of this template. Use `--tyrian-*` variables so pigments continue to come from `source/themes/`, aliases from `source/themeColorBindings.json`, and derived alpha from `source/themeOpacityContract.json`; role membership is owned by `source/themeRoleContract.json`.

Source CSS may use local `@import` rules. Generated KDE output is flattened and must not import Breeze, `kcolorscheme`, external paths, or runtime CSS files.
