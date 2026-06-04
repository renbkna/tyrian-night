# Tyrian Night for Ghostty

Ghostty controls the terminal window: background, foreground, cursor, selection, and the ANSI palette used by terminal applications.

Generated themes live in `terminal/ghostty/themes/`:

- `tyrian-night`
- `tyrian-abyss`
- `tyrian-dawn`

Install by copying or symlinking those files into `~/.config/ghostty/themes/`, then add this to `~/.config/ghostty/config`:

```ini
theme = dark:tyrian-night,light:tyrian-dawn
```

`config.example` is the full Tyrian Ghostty config template. The live installer writes this config with the installed GTK chrome CSS path.
