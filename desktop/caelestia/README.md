# Tyrian Night for Caelestia

Caelestia uses Material-style color tokens plus terminal palette tokens. Tyrian
generates them directly from the neutral role contract in `source/themes/`.

Generated outputs:

- `schemes/tyrian/*/*.txt` is the Caelestia scheme registry layout.
- `state/*.scheme.json` is a direct current-scheme state file.
- `hypr/*.lua` and `hypr/*.conf` are the current and legacy Hyprland variable modules.

On a clean checkout, materialize these generated assets first:

```sh
bun run build:desktop-themes
```

For a user-level live install, use Tyrian's transactional publisher:

```sh
node scripts/installLiveTyrian.mjs --target=caelestia --apply
```

The installer atomically replaces Caelestia's watched `scheme.json`, the current
Hyprland scheme, and terminal sequences. It reads `configProvider` from
`hyprctl -j status`: `lua` publishes `current.lua`, while `hyprlang` publishes
legacy `current.conf`. Existing config files do not decide the active provider.
For an offline install, pass `--hyprland-mode=lua` or
`--hyprland-mode=legacy`. Even `--link` leaves watched runtime targets as
regular files; only stable assets are linked to the repository.

These destinations and formats match the current upstream
[Caelestia CLI publisher](https://github.com/caelestia-dots/cli/blob/main/src/caelestia/utils/theme.py),
the shell's watched
[`scheme.json`](https://github.com/caelestia-dots/shell/blob/main/services/Colours.qml),
and Hyprland's reported
[`configProvider`](https://github.com/hyprwm/Hyprland/blob/main/src/helpers/SystemInfo.cpp).

This is a projection publisher for an existing Caelestia/Hyprland installation.
It does not install either project or edit `hyprland.lua` / `hyprland.conf` to
load Caelestia. The upstream integration must already consume the matching
`hypr/scheme/current` module.

`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME` are resolved once by the
installer. The defaults below are examples; non-default roots receive the same
relative Caelestia paths. Roots outside the destination home are rejected because
the durable recovery record cannot safely authorize an unrelated filesystem tree.

The `schemes/tyrian/` tree is packaging input for distributions that choose to
ship Tyrian in Caelestia's scheme registry. The user installer deliberately does
not write into Python `site-packages` or another package-manager-owned directory.
The live state publisher does not require that registry installation.

## Wallpaper

Caelestia's wallpaper switcher and launcher read from
`~/Pictures/Wallpapers` by default (override via the `wallpapers` path in
`~/.config/caelestia/shell.json`). To make the Tyrian wallpaper available:

```sh
mkdir -p "$HOME/Pictures/Wallpapers"
cp assets/wallpaper-tyrian.png "$HOME/Pictures/Wallpapers/"
```

Then set it live with `caelestia wallpaper -f ~/Pictures/Wallpapers/wallpaper-tyrian.png`.
