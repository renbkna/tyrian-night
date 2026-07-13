# Tyrian Night for fish

fish controls shell input syntax highlighting, autosuggestions, and pager colors. It does not control the terminal window background or the prompt when Starship is active.

From a clean checkout, materialize the generated terminal assets first:

```sh
bun run build:terminal-themes
```

Source one generated theme from your interactive fish config:

```fish
source /path/to/tyrian-night/terminal/fish/themes/tyrian-nocturne.fish
```

Use `terminal/fish/conf.d/tyrian-night.fish` if you want Fish to select the repo Starship config and startup path without replacing your main Fish config. This repository file is a template: copy it into `~/.config/fish/conf.d/`, then replace `/path/to/tyrian-night` in the copied file with the absolute path to your checkout. Do not symlink the unresolved template.

Use `terminal/fish/config.example.fish` only as a full config template. The live installer writes the generated `conf.d` snippet and greeting function into Fish's native user config paths with the installed Tyrian root. The generated themes use `set -g`, not `set -U`, so sourcing them does not rewrite universal fish variables.
