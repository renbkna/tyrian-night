# Tyrian Night for foot

foot controls the terminal window: background, foreground, cursor, selection, and the ANSI palette used by terminal applications.

Generated themes live in `terminal/foot/themes/`:

- `tyrian-night.ini`
- `tyrian-nocturne.ini`
- `tyrian-pastel.ini`
- `tyrian-abyss.ini`
- `tyrian-dawn.ini`

Symlink those files into `~/.config/foot/themes/` so they follow the checkout, then include the default dark and light themes from `~/.config/foot/foot.ini`:

```ini
include=~/.config/foot/themes/tyrian-abyss.ini
include=~/.config/foot/themes/tyrian-dawn.ini

[main]
initial-color-theme=dark
```

Dark source themes populate Foot's `[colors-dark]` section and Dawn populates `[colors-light]`.
