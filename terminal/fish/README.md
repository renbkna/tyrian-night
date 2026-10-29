# Tyrian Night for fish

fish controls shell input syntax highlighting, autosuggestions, and pager colors. It does not control the terminal window background or the prompt when Starship is active.

To use the Tyrian startup layer, link one variant's startup file as `conf.d/tyrian-night.fish`, and the greeting, into fish's config. Run this from the checkout root; it links Nocturne, and rerunning it with another variant switches, because the link name stays the same. It needs fish 3.5 or later (the `path` builtin) and fastfetch built with chafa for the greeting.

```fish
mkdir -p ~/.config/fish/conf.d ~/.config/fish/functions
ln -sfn (path resolve terminal/fish/conf.d/tyrian-nocturne.fish) ~/.config/fish/conf.d/tyrian-night.fish
ln -sfn (path resolve terminal/fish/functions/fish_greeting.fish) ~/.config/fish/functions/fish_greeting.fish
```

The startup file follows its symlink back to the checkout, sets `TYRIAN_NIGHT_ROOT` and `TYRIAN_NIGHT_THEME`, sources that variant's fish theme, and points `STARSHIP_CONFIG` at that variant's [Starship prompt](../starship/README.md); your `config.fish` still runs `starship init fish | source`. The greeting runs fastfetch with the variant's colors and the Tyrian logo, and reports an error instead of a greeting when no startup file is linked. Moving the checkout only needs the two commands rerun.

To take the colors alone, source one theme from your interactive fish config instead:

```fish
source /path/to/tyrian-night/terminal/fish/themes/tyrian-abyss.fish
```

The generated themes use `set -g`, not `set -U`, so sourcing them does not rewrite universal fish variables.
