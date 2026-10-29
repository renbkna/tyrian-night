# Tyrian Night for foot

foot controls the terminal window: background, foreground, cursor, selection, and the ANSI palette used by terminal applications.

From a clean checkout, materialize the generated terminal assets first:

```sh
bun run generate --product=desktop
```

Generated themes live in `terminal/foot/themes/`:

- `tyrian-night.ini`
- `tyrian-nocturne.ini`
- `tyrian-pastel.ini`
- `tyrian-abyss.ini`
- `tyrian-dawn.ini`

Install by copying or symlinking those files into `~/.config/foot/themes/`, then include the default dark and light themes from `~/.config/foot/foot.ini`:

```ini
include=~/.config/foot/themes/tyrian-abyss.ini
include=~/.config/foot/themes/tyrian-dawn.ini

[main]
initial-color-theme=dark
```

Dark source themes populate Foot's `[colors-dark]` section and Dawn populates `[colors-light]`. The live installer installs these theme files; `foot.ini` stays yours.
