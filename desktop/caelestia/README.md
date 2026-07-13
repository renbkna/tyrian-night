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
node scripts/installLiveTyrian.mjs --apply
```

The installer atomically replaces Caelestia's watched `scheme.json`, the current
Hyprland scheme, and terminal sequences. It selects `current.lua` when the active
Hyprland configuration is `hyprland.lua`, otherwise it publishes legacy
`current.conf`. Even `--link` leaves those runtime targets as regular files;
only stable assets are linked to the repository.

`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME` are resolved once by the
installer. The defaults below are examples; non-default roots receive the same
relative Caelestia paths. Roots outside the destination home are rejected because
the durable recovery record cannot safely authorize an unrelated filesystem tree.

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
Quickshell reads colors directly from
`${XDG_STATE_HOME:-$HOME/.local/state}/caelestia/scheme.json`.

## Wallpaper

Caelestia's wallpaper switcher and launcher read from
`~/Pictures/Wallpapers` by default (override via the `wallpapers` path in
`~/.config/caelestia/shell.json`). To make the Tyrian wallpaper available:

```sh
mkdir -p "$HOME/Pictures/Wallpapers"
cp assets/wallpaper-tyrian.png "$HOME/Pictures/Wallpapers/"
```

Then set it live with `caelestia wallpaper -f ~/Pictures/Wallpapers/wallpaper-tyrian.png`.
