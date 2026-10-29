# Tyrian Night for KDE Plasma

KDE uses these generated files:

- `color-schemes/*.colors` are KDE color schemes.
- `plasma/desktoptheme/*/` are complete Tyrian Plasma desktop-theme packages.
- `union/css/styles/*/style.css` are generated Tyrian Union CSS application-style packages from `source/union-css/index.css`.

Tyrian owns these package files directly. They do not require a local Monochrome
theme package or any other third-party base theme at install time. Their colors
are projected directly from neutral roles in `source/themes/`, not from a VS Code theme.
The color scheme and Plasma theme carry colors only; widget style, icons, cursor and toolbars
stay your choice.

Install the Night color scheme by copying or symlinking
`desktop/kde/color-schemes/TyrianNight.colors` into `~/.local/share/color-schemes/`, then
apply it with:

```sh
plasma-apply-colorscheme TyrianNight
```

Install the Night Plasma package by copying or symlinking
`desktop/kde/plasma/desktoptheme/TyrianNight` into
`~/.local/share/plasma/desktoptheme/`, then apply it with:

```sh
plasma-apply-desktoptheme TyrianNight
```

Union CSS packages are kept as Plasma 6.7 tech-preview assets only. To test Union,
install your distro's `union` package, copy or symlink
`/usr/share/union/css/defaults` into `~/.local/share/union/css/defaults`, copy
or symlink the packaged Union base style directories
`/usr/share/union/css/styles/breeze`, `/usr/share/union/css/styles/breeze-mobile`,
and `/usr/share/union/css/styles/breeze-rtl` into `~/.local/share/union/css/styles/`,
then copy or symlink `desktop/kde/union/css/styles/TyrianNight` into
`~/.local/share/union/css/styles/TyrianNight` and opt into Union from a test
session.

For a local runtime smoke test, use:

```sh
bun run union:smoke
```
