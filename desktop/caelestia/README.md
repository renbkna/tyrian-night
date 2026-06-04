# Tyrian Night for Caelestia

Caelestia uses Material-style color tokens plus terminal palette tokens. Tyrian
generates those tokens from the same source theme JSON files used by the editor,
Ghostty, fish, Starship, Zed, and KDE outputs.

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
scheme data directory so `caelestia scheme set` can select Tyrian by name.
