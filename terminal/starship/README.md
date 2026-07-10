# Tyrian Night for Starship

Starship controls the prompt. `terminal/starship/tyrian-night.toml` uses a Tyrian prompt layout and includes named palettes for Night, Nocturne, Night Old, Abyss, and Dawn.

Use it directly:

```fish
set -gx STARSHIP_CONFIG /path/to/tyrian-night/terminal/starship/tyrian-night.toml
starship init fish | source
```

To switch palette, change the top-level value:

```toml
palette = "tyrian_nocturne"
```

The prompt uses Nerd Font symbols, matching the terminal example fonts.
