# Tyrian Night Desktop Installer

This product installs shared Tyrian terminal files plus exactly one explicit desktop profile into one Linux user account. The profiles are KDE Plasma 6 or Caelestia on Hyprland. It is invasive configuration management, not a portable editor theme.

## Support Contract

The installer supports Linux systems that provide:

- Node.js at or above the `engines.node` floor in `apps/desktop/package.json`;
- GNU `mv` with `--exchange` (directories are replaced without ever being absent);
- util-linux `flock` (one desktop command changes files at a time);
- user-owned XDG configuration, data, and state roots inside the selected home directory.

The Plasma profile manages Plasma 6 configuration. The installer does not branch on `XDG_SESSION_TYPE`, so it does not claim a separate Wayland or X11 contract.

The Caelestia profile requires an existing Caelestia/Hyprland setup. It publishes Caelestia color state, terminal sequences, and the selected Hyprland scheme module. It does not install Caelestia, replace Caelestia's own Fastfetch or Starship configuration, configure the main Hyprland file, or provide a Hyprland rice.

Unsupported mutation semantics fail before the first backup or file change.

## Style Install

Both profiles install the Ghostty and Foot theme files and own fish's Tyrian startup snippet and greeting. The Ghostty and Foot config files belong to the user and are never written: select a theme there as each terminal's README shows. Each command then manages only its selected desktop surface. A Plasma apply does not write Hyprland or Caelestia runtime paths; a Caelestia apply does not write KDE or Plasma paths. The stable copied source under `~/.local/share/tyrian-night/` contains generated assets for both profiles, but it is installer-owned data rather than live desktop configuration.

The theme family contract owns the selected desktop theme; it is currently Tyrian Abyss. The catalog's appearance-specific terminal defaults are separate: the fish snippet sources the dark default, and the terminal READMEs show both. The installer derives its materialized assets, package identifiers, and Caelestia state from those owned roles rather than a hard-coded variant.

```sh
# Read-only Plasma plan, then apply.
bun run desktop:plasma:preview
bun run desktop:plasma:apply

# Read-only Caelestia plan, then apply.
bun run desktop:caelestia:preview
bun run desktop:caelestia:apply

# Undo the latest style apply by restoring its backup.
bun run desktop:recover
```

Preview reads repository and destination state only. It does not generate ignored assets, take the desktop lock, create backups, or publish configuration. Apply generates required projections before mutation.

For Caelestia, the installer asks the active Hyprland instance for `configProvider` with `hyprctl -j status`. Provider `lua` selects `current.lua`; provider `hyprlang` selects legacy `current.conf`. File presence is not provider detection. For an offline install or a different destination home, select the contract explicitly:

```sh
bun run desktop:caelestia:apply --hyprland-mode=lua
# or
bun run desktop:caelestia:apply --hyprland-mode=legacy
```

The default apply copies stable assets under `~/.local/share/tyrian-night/`; the checkout can then be moved or deleted. `--link` is only for development when live stable assets should follow the checkout:

```sh
node apps/desktop/src/installLiveTyrian.mjs --target=plasma --apply --link
```

Every apply first copies the current state of each path it may change into a new backup under `~/.local/state/tyrian-night/backups/`. Each file, link, and directory is then replaced atomically, so no path is ever partial or missing. The install is deterministic: if an apply fails or is interrupted, running it again completes it. `desktop:recover` restores the latest backup exactly (including removing paths the install created) and deletes it, so repeated recovery steps back through earlier applies. It refuses, changing nothing, when the latest backup belongs to another owner.

Ownership state is profile-scoped and retains each profile's XDG roots, so moving XDG configuration does not orphan the previous generation. If no ownership manifest exists, the installer only records its current outputs; it does not migrate or clean up historical paths.

State written by earlier installer versions is not read. A manifest that still lists the Ghostty or Foot config is refused before anything in the home changes, and the error names the entry: delete it from `~/.local/state/tyrian-night/live-owned-paths.json` (the file itself stays yours) and apply again. Delete backups made by earlier versions, including those of the removed Plasma layout installer, from `~/.local/state/tyrian-night/backups/` instead of recovering them: they can overwrite the now user-owned Ghostty and Foot configs.

## Ownership

`apps/desktop/package.json` owns the desktop product version and runtime floor; the installer lives in `apps/desktop/src` and runs through the root `desktop:*` scripts. Shared theme roles remain owned by `source/`; generated terminal and desktop files are projections.
