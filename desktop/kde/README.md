# Tyrian Night for KDE Plasma

Generated from `source/themes/`, with no third-party base theme:

- `color-schemes/<Variant>.colors`: colour schemes.
- `plasma/desktoptheme/<Variant>/`: Plasma desktop themes.
- `union/css/styles/<Variant>/`: Union application styles (Plasma 6.7 tech preview), built from
  `source/union-css/`.

The colour scheme and Plasma theme carry colours only. Install by copying or linking, then apply:

```sh
cp desktop/kde/color-schemes/TyrianNight.colors ~/.local/share/color-schemes/
plasma-apply-colorscheme TyrianNight

cp -r desktop/kde/plasma/desktoptheme/TyrianNight ~/.local/share/plasma/desktoptheme/
plasma-apply-desktoptheme TyrianNight
```

To try Union, install `union`, put its `defaults` and the `breeze`, `breeze-mobile` and
`breeze-rtl` styles from `/usr/share/union/css/` under `~/.local/share/union/css/`, add
`union/css/styles/TyrianNight` next to them, and opt into Union in a test session.
`bun run union:smoke` opens the controls offscreen under Union for a few hundred milliseconds
and exits; it needs `qml6` and Union installed and makes no assertions.
