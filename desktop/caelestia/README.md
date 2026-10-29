# Tyrian Night for Caelestia

Caelestia uses Material-style color tokens plus terminal palette tokens. Tyrian
generates them directly from the neutral role contract in `source/themes/`.

Generated outputs:

- `schemes/tyrian/*/*.txt` is the Caelestia scheme registry layout.
- `state/*.scheme.json` is a direct current-scheme state file.
- `hypr/*.lua` and `hypr/*.conf` are the current and legacy Hyprland variable modules.

To apply one variant, copy its files over Caelestia's current scheme. Caelestia
watches these files, so copy rather than symlink them:

```sh
cp desktop/caelestia/state/tyrian-abyss.scheme.json ~/.local/state/caelestia/scheme.json
cp desktop/caelestia/state/tyrian-abyss.sequences.txt ~/.local/state/caelestia/sequences.txt
cp desktop/caelestia/hypr/tyrian-abyss.lua ~/.config/hypr/scheme/current.lua
```

Use the `.lua` module when `hyprctl -j status` reports `"configProvider": "lua"`,
and copy the `.conf` module to `~/.config/hypr/scheme/current.conf` when it
reports `hyprlang`. Non-default `XDG_STATE_HOME` and `XDG_CONFIG_HOME` roots
take the same relative paths.

These destinations and formats match the current upstream
[Caelestia CLI publisher](https://github.com/caelestia-dots/cli/blob/main/src/caelestia/utils/theme.py),
the shell's watched
[`scheme.json`](https://github.com/caelestia-dots/shell/blob/main/services/Colours.qml),
and Hyprland's reported
[`configProvider`](https://github.com/hyprwm/Hyprland/blob/main/src/helpers/SystemInfo.cpp).

These files theme an existing Caelestia/Hyprland installation. They do not
install either project or make `hyprland.lua` / `hyprland.conf` load Caelestia;
the upstream integration must already consume the matching `hypr/scheme/current`
module.

The `schemes/tyrian/` tree is packaging input for distributions that choose to
ship Tyrian in Caelestia's scheme registry. Applying a scheme as above does not
require that registry installation.

## Wallpaper

Caelestia's wallpaper switcher and launcher read from
`~/Pictures/Wallpapers` by default (override via the `wallpapers` path in
`~/.config/caelestia/shell.json`). To make the Tyrian wallpaper available:

```sh
mkdir -p "$HOME/Pictures/Wallpapers"
cp assets/wallpaper-tyrian.png "$HOME/Pictures/Wallpapers/"
```

Then set it live with `caelestia wallpaper -f ~/Pictures/Wallpapers/wallpaper-tyrian.png`.
