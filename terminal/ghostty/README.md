# Tyrian Night for Ghostty

Ghostty controls the terminal window: background, foreground, cursor, selection, and the ANSI palette used by terminal applications.

Generated themes live in `terminal/ghostty/themes/`:

- `tyrian-night`
- `tyrian-nocturne`
- `tyrian-pastel`
- `tyrian-abyss`
- `tyrian-dawn`

Symlink those files into `~/.config/ghostty/themes/` so they follow the checkout, then add this to `~/.config/ghostty/config.ghostty`:

```ini
theme = dark:tyrian-abyss,light:tyrian-dawn
window-theme = ghostty
```

Each native Ghostty theme owns its matching titlebar colors, so automatic dark/light selection changes terminal content and chrome together. Ghostty applies theme titlebar colors only with `window-theme = ghostty`. No static dark-only GTK CSS is required.
