# Tyrian Night for KDE Plasma

Generated from `source/themes/`, with no third-party base theme:

- `color-schemes/<Variant>.colors`: colour schemes.
- `plasma/desktoptheme/<Variant>/`: Plasma desktop themes.
- `union/styles/<Variant>/`: Union application style packages (Union 6.8), built from
  `source/union-css/`.

The colour scheme and Plasma theme carry colours only. Install by copying or linking, then apply:

```sh
cp desktop/kde/color-schemes/TyrianNight.colors ~/.local/share/color-schemes/
plasma-apply-colorscheme TyrianNight

cp -r desktop/kde/plasma/desktoptheme/TyrianNight ~/.local/share/plasma/desktoptheme/
plasma-apply-desktoptheme TyrianNight
```

Union reads style packages from `union/styles/` in each data directory. Install `union`, copy or
link a style, then pick it under System Settings > Application Style, or start one application
with `UNION_STYLE_NAME=TyrianNight`:

```sh
mkdir -p ~/.local/share/union/styles
cp -r desktop/kde/union/styles/TyrianNight ~/.local/share/union/styles/
```

`bun run union:smoke` opens the controls offscreen with the installed `TyrianNight` style for a
few hundred milliseconds and exits; it needs `qml6` and Union and makes no assertions.
