# Tyrian Night for fish

fish colours the command line (syntax, autosuggestions, pager); the terminal and Starship colour
the rest.

Link one variant's startup file as `tyrian-night.fish`, plus the greeting. From the checkout root
(rerun with another variant to switch; needs fish 3.5+ and fastfetch with chafa):

```fish
mkdir -p ~/.config/fish/conf.d ~/.config/fish/functions
ln -sfn (path resolve terminal/fish/conf.d/tyrian-nocturne.fish) ~/.config/fish/conf.d/tyrian-night.fish
ln -sfn (path resolve terminal/fish/functions/fish_greeting.fish) ~/.config/fish/functions/fish_greeting.fish
```

The startup file finds the checkout through its link, sources the variant's fish theme and sets
`STARSHIP_CONFIG` to its [prompt](../starship/README.md); `config.fish` still runs
`starship init fish | source`. The greeting runs fastfetch in the variant's colours.

Colours only:

```fish
source /path/to/tyrian-night/terminal/fish/themes/tyrian-abyss.fish
```

Themes use `set -g`, so they never rewrite universal variables.
