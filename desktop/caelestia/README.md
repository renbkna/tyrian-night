# Tyrian Night for Caelestia

Generated from `source/themes/`:

- `state/<variant>.scheme.json` and `.sequences.txt`: Caelestia's current scheme.
- `hypr/<variant>.lua` (Lua config) and `.conf` (hyprlang): Hyprland scheme modules.
- `schemes/tyrian/`: the scheme-registry layout, for distributions that package Tyrian.

Apply a variant by copying (Caelestia watches these files, so links don't work):

```sh
cp desktop/caelestia/state/tyrian-abyss.scheme.json ~/.local/state/caelestia/scheme.json
cp desktop/caelestia/state/tyrian-abyss.sequences.txt ~/.local/state/caelestia/sequences.txt
cp desktop/caelestia/hypr/tyrian-abyss.lua ~/.config/hypr/scheme/current.lua
```

If `hyprctl -j status` reports `hyprlang`, copy the `.conf` module to `current.conf` instead.
Your Caelestia setup must already load `hypr/scheme/current`. Paths follow the upstream
[CLI](https://github.com/caelestia-dots/cli/blob/main/src/caelestia/utils/theme.py) and
[shell](https://github.com/caelestia-dots/shell/blob/main/services/Colours.qml).

Wallpaper: copy `assets/wallpaper-tyrian.png` into `~/Pictures/Wallpapers/`, then
`caelestia wallpaper -f ~/Pictures/Wallpapers/wallpaper-tyrian.png`.
