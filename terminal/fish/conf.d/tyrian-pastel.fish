# Resolves symlinks, then climbs from <root>/terminal/fish/conf.d/tyrian-pastel.fish to <root>.
set -g TYRIAN_NIGHT_ROOT (path resolve (status current-filename) | path dirname | path dirname | path dirname | path dirname)
set -g TYRIAN_NIGHT_THEME tyrian-pastel
source $TYRIAN_NIGHT_ROOT/terminal/fish/themes/$TYRIAN_NIGHT_THEME.fish
set -gx STARSHIP_CONFIG $TYRIAN_NIGHT_ROOT/terminal/starship/$TYRIAN_NIGHT_THEME.toml
