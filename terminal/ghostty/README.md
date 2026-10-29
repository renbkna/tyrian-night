# Tyrian Night for Ghostty

`themes/` holds one theme per variant (terminal colours, ANSI palette and titlebar). Link them
into `~/.config/ghostty/themes/`, then in `~/.config/ghostty/config.ghostty`:

```ini
theme = dark:tyrian-abyss,light:tyrian-dawn
window-theme = ghostty
```

`window-theme = ghostty` lets the theme colour the titlebar too, so dark/light switching changes
both.
