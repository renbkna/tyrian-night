function fish_greeting
    if not set -q TYRIAN_NIGHT_ROOT TYRIAN_NIGHT_THEME
        echo "fish_greeting: link a terminal/fish/conf.d/tyrian-*.fish as ~/.config/fish/conf.d/tyrian-night.fish" >&2
        return 1
    end
    fastfetch --config $TYRIAN_NIGHT_ROOT/terminal/fastfetch/$TYRIAN_NIGHT_THEME.jsonc --logo $TYRIAN_NIGHT_ROOT/assets/tyrian-fetch.webp
end
