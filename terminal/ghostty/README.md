# Tyrian Night for Ghostty

Ghostty controls the terminal window: background, foreground, cursor, selection, and the ANSI palette used by terminal applications.

From a clean checkout, materialize the generated terminal assets first:

```sh
bun run generate --product=desktop
```

Generated themes live in `terminal/ghostty/themes/`:

- `tyrian-night`
- `tyrian-nocturne`
- `tyrian-pastel`
- `tyrian-abyss`
- `tyrian-dawn`

Install by copying or symlinking those files into `~/.config/ghostty/themes/`, then add this to `~/.config/ghostty/config.ghostty`:

```ini
theme = dark:tyrian-abyss,light:tyrian-dawn
window-theme = ghostty
```

The live installer installs these theme files; the Ghostty config stays yours. Each native Ghostty theme owns its matching titlebar colors, so automatic dark/light selection changes terminal content and chrome together. Ghostty applies theme titlebar colors only with `window-theme = ghostty`. No static dark-only GTK CSS is required.
