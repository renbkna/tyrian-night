# Union CSS Rice Source

`index.css` is the editable Union application-style entry point. It imports the
component-family files in `parts/`.

Change control shapes, spacing, radii, and widget rules here. `scripts/desktopThemes.mjs`
injects Tyrian palette and shape tokens into `/* TYRIAN_GENERATED_TOKENS */` for each theme and writes the
generated styles under `desktop/kde/union/css/styles/*/style.css`.

Keep generated color values out of this template. Use `--tyrian-*` variables so the
palette continues to come from `source/themes/`.

Source CSS may use local `@import` rules. Generated KDE output is flattened and
must not import Breeze, `kcolorscheme`, external paths, or runtime CSS files.
