# Tyrian Night for Ghostty

Ghostty controls the terminal window: background, foreground, cursor, selection, and the ANSI palette used by terminal applications.

From a clean checkout, materialize the generated terminal assets first:

```sh
bun run build:terminal-themes
```

Generated themes live in `terminal/ghostty/themes/`:

- `tyrian-night`
- `tyrian-nocturne`
- `tyrian-pastel`
- `tyrian-night-old`
- `tyrian-abyss`
- `tyrian-dawn`

Install by copying or symlinking those files into `~/.config/ghostty/themes/`, then add this to `~/.config/ghostty/config`:

```ini
theme = dark:tyrian-nocturne,light:tyrian-dawn
```

`config.example` is the full Tyrian Ghostty config template. Each native Ghostty theme owns its matching titlebar colors, so automatic dark/light selection changes terminal content and chrome together. No static dark-only GTK CSS is required.
