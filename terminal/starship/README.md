# Tyrian Night for Starship

Starship controls the prompt. `terminal/starship/<variant>.toml` (for example `tyrian-nocturne.toml`) is the Tyrian prompt layout with that variant's palette.

The fish startup files in [`terminal/fish`](../fish/README.md) set `STARSHIP_CONFIG` to their variant's prompt. Without them:

```fish
set -gx STARSHIP_CONFIG /path/to/tyrian-night/terminal/starship/tyrian-nocturne.toml
starship init fish | source
```

The prompt uses Nerd Font symbols, matching the terminal example fonts.
