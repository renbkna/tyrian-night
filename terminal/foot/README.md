# Tyrian Night for foot

foot controls the terminal window: background, foreground, cursor, selection, and the ANSI palette used by terminal applications.

Generated themes live in `terminal/foot/themes/`:

- `tyrian-night.ini`
- `tyrian-nocturne.ini`
- `tyrian-night-old.ini`
- `tyrian-abyss.ini`
- `tyrian-dawn.ini`

Install by copying or symlinking those files into `~/.config/foot/themes/`, then include one theme from `~/.config/foot/foot.ini`:

```ini
include=~/.config/foot/themes/tyrian-nocturne.ini
```

`foot.ini` is the full Tyrian foot config template. The live installer writes this config with the installed Foot theme path.
