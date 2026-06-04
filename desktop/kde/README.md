# Tyrian Night for KDE Plasma

KDE uses these generated files for the Tyrian rice:

- `color-schemes/*.colors` are KDE color schemes.
- `plasma/desktoptheme/*/` are complete Tyrian Plasma desktop-theme packages.
- `plasma/look-and-feel/*/` are complete Tyrian look-and-feel packages with setup defaults.

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
