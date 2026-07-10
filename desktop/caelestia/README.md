# Tyrian Night for Caelestia

Caelestia uses Material-style color tokens plus terminal palette tokens. Tyrian
generates those tokens from the same source theme JSON files used by the editor,
Ghostty, Foot, fish, Starship, Zed, and KDE outputs.

Generated outputs:

- `schemes/tyrian/*/*.txt` is the Caelestia scheme registry layout.
- `state/*.scheme.json` is a direct current-scheme state file.
- `hypr/*.conf` is the Hyprland variable file Caelestia sources.

For a user-level live install, consume the Night files like this:

```sh
install -Dm644 desktop/caelestia/state/tyrian-night.scheme.json "$HOME/.local/state/caelestia/scheme.json"
install -Dm644 desktop/caelestia/hypr/tyrian-night.conf "$HOME/.config/hypr/scheme/current.conf"
```

That keeps Caelestia's shell/layout/widget logic intact while replacing its
current colors with Tyrian-owned colors.

For a packaged system install, copy the `schemes/tyrian/` tree into Caelestia's
scheme data directory so `caelestia scheme set` can select Tyrian by name:

```sh
sudo cp -r desktop/caelestia/schemes/tyrian /usr/lib/python3.14/site-packages/caelestia/data/schemes/
```

Adjust the `site-packages` path to match the Python version shipped by your
`caelestia-cli` package (`pacman -Ql caelestia-cli | grep 'data/schemes/$'`).

Caveat: this directory is owned by the `caelestia-cli` package. A CLI upgrade
re-ships `data/schemes/` and removes the copied `tyrian/` tree, so
`caelestia scheme list --flavours` / `--modes` and `caelestia scheme set -n
tyrian` will fail with `FileNotFoundError` / `ValueError("Invalid scheme
name")` until the copy is re-run. The live install (state file above) is
unaffected and the shell keeps rendering Tyrian colors either way, since
Quickshell reads colors directly from `~/.local/state/caelestia/scheme.json`.

## Wallpaper

Caelestia's wallpaper switcher and launcher read from
`~/Pictures/Wallpapers` by default (override via the `wallpapers` path in
`~/.config/caelestia/shell.json`). To make the Tyrian wallpaper available:

```sh
mkdir -p "$HOME/Pictures/Wallpapers"
cp assets/wallpaper-tyrian.png "$HOME/Pictures/Wallpapers/"
```

Then set it live with `caelestia wallpaper -f ~/Pictures/Wallpapers/wallpaper-tyrian.png`.
