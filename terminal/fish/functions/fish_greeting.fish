function fish_greeting
    set -l tyrian_night_root $TYRIAN_NIGHT_ROOT

    if test -z "$tyrian_night_root"
        set -l greeting_path (status current-filename)
        if test -n "$greeting_path"
            set tyrian_night_root (realpath (dirname $greeting_path)/../../..)
        end
    end

    if test -n "$tyrian_night_root"
        fastfetch --config $tyrian_night_root/terminal/fastfetch/tyrian-night.jsonc
    end
end
