if status is-interactive
    set -gx TYRIAN_NIGHT_ROOT "/path/to/tyrian-night"
    source $TYRIAN_NIGHT_ROOT/terminal/fish/themes/tyrian-night.fish
    set -gx STARSHIP_CONFIG $TYRIAN_NIGHT_ROOT/terminal/starship/tyrian-night.toml

    starship init fish | source
end
