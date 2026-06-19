# Tyrian Night for KDE Plasma

KDE uses these generated files for the Tyrian rice:

- `color-schemes/*.colors` are KDE color schemes.
- `plasma/desktoptheme/*/` are complete Tyrian Plasma desktop-theme packages.
- `plasma/look-and-feel/*/` are complete Tyrian look-and-feel packages with setup defaults.
- `union/css/styles/*/style.css` are generated Tyrian Union CSS application-style packages from `source/union-css/index.css`.

Tyrian owns these package files directly. They do not require a local Monochrome
theme package or any other third-party base theme at install time.

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

Install the look-and-feel package by copying or symlinking
`desktop/kde/plasma/look-and-feel/TyrianNight` into
`~/.local/share/plasma/look-and-feel/`. The live installer and rice command do
these package installs automatically.

Union CSS packages are kept as Plasma 6.7 tech-preview assets only. The live
installer leaves KDE on Breeze application style, removes the old persisted
`QT_QUICK_CONTROLS_STYLE=org.kde.union` env file, and clears already-imported
user-session Union overrides when `systemctl` and
`dbus-update-activation-environment` are available. To test Union manually,
install your distro's `union` package, copy or symlink
`/usr/share/union/css/defaults` into `~/.local/share/union/css/defaults`, copy
or symlink `desktop/kde/union/css/styles/TyrianNight` into
`~/.local/share/union/css/styles/TyrianNight`, then opt into Union from a test
session.

For a local runtime smoke test, use:

```sh
bun run union:smoke
```
