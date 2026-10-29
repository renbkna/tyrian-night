# Tyrian Night for foot

`themes/` holds one theme per variant; dark variants fill `[colors-dark]`, Dawn fills
`[colors-light]`. foot's `[csd]` title-bar section is not per color theme, so each variant's
title-bar colors are a separate file in `csd/`; include the one for your initial theme. When foot
switches between its dark and light theme, the title bar keeps the included variant's colors. Link
both directories into `~/.config/foot/`, then in `~/.config/foot/foot.ini`:

```ini
include=~/.config/foot/themes/tyrian-abyss.ini
include=~/.config/foot/themes/tyrian-dawn.ini
include=~/.config/foot/csd/tyrian-abyss.ini

[main]
initial-color-theme=dark
```
