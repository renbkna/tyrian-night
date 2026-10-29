# Tyrian Night for Starship

`<variant>.toml` is the Tyrian prompt in that variant's palette (Nerd Font symbols). The
[fish startup files](../fish/README.md) select it; without them:

```fish
set -gx STARSHIP_CONFIG /path/to/tyrian-night/terminal/starship/tyrian-nocturne.toml
starship init fish | source
```
