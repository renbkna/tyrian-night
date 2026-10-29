# Tyrian Night for foot

`themes/` holds one theme per variant; dark variants fill `[colors-dark]`, Dawn fills
`[colors-light]`. Link them into `~/.config/foot/themes/`, then in `~/.config/foot/foot.ini`:

```ini
include=~/.config/foot/themes/tyrian-abyss.ini
include=~/.config/foot/themes/tyrian-dawn.ini

[main]
initial-color-theme=dark
```
