# Tyrian Night for fish

fish controls shell input syntax highlighting, autosuggestions, and pager colors. It does not control the terminal window background or the prompt when Starship is active.

Source one generated theme from your interactive fish config:

```fish
source /path/to/tyrian-night/terminal/fish/themes/tyrian-night.fish
```

Use `terminal/fish/config.example.fish` as the full Tyrian fish config template if you also want fish to select the repo Starship config and startup path exactly. The live installer writes this full config with the installed Tyrian root. The generated themes use `set -g`, not `set -U`, so sourcing them does not rewrite universal fish variables.
