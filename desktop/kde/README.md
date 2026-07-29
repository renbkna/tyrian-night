# Tyrian Night for KDE Plasma

KDE uses these generated files for the Tyrian rice:

- `color-schemes/*.colors` are KDE color schemes.
- `plasma/desktoptheme/*/` are complete Tyrian Plasma desktop-theme packages.
- `plasma/look-and-feel/*/` are complete Tyrian look-and-feel packages with setup defaults.
- `union/css/styles/*/style.css` are generated Tyrian Union CSS application-style packages from `source/union-css/index.css`.

Tyrian owns these package files directly. They do not require a local Monochrome
theme package or any other third-party base theme at install time. Their colors
are projected directly from neutral roles in `source/themes/`, not from a VS Code theme.
Papirus supplies the icon policy: light themes use `Papirus` and dark themes use
`Papirus-Dark`.

On a clean checkout, materialize the generated desktop assets before following
the manual copy commands:

```sh
bun run build:desktop-themes
```

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

Install the look-and-feel package by copying (Plasma 6 does not load global
themes through symlinks)
`desktop/kde/plasma/look-and-feel/TyrianNight` into
`~/.local/share/plasma/look-and-feel/`. The explicit Plasma live profile
(`bun run desktop:plasma:apply`) and the Plasma-only rice command do these
package installs automatically.

Union CSS packages are kept as Plasma 6.7 tech-preview assets only. The live Plasma
profile leaves KDE on Breeze application style and does not mutate the live
D-Bus/session environment. It does not migrate or clean up existing Union runtime
or environment paths. Clear an already-imported override manually before testing.
To test Union manually,
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
