# Tyrian Night Desktop Installer

This product installs shared Tyrian terminal files plus exactly one explicit desktop profile into one Linux user account. The profiles are KDE Plasma 6 or Caelestia on Hyprland. It is invasive configuration management, not a portable editor theme.

## Support Contract

The installer supports Linux systems that provide:

- Node.js 22.19 or newer;
- GNU `mv` with `--exchange` (directories are replaced without ever being absent);
- util-linux `flock` (one desktop command changes files at a time);
- user-owned XDG configuration, data, and state roots inside the selected home directory.

The Plasma profile manages Plasma 6 configuration. The installer does not branch on `XDG_SESSION_TYPE`, so it does not claim a separate Wayland or X11 contract. The full rice additionally requires an active `plasma-plasmashell.service`, `qdbus6`, `kscreen-doctor`, `systemctl`, and the widgets in [`../../rice/plasma-layout/requirements.md`](../../rice/plasma-layout/requirements.md).

The Caelestia profile requires an existing Caelestia/Hyprland setup. It publishes Caelestia color state, terminal sequences, and the selected Hyprland scheme module. It does not install Caelestia, replace Caelestia's own Fastfetch or Starship configuration, configure the main Hyprland file, or provide a Hyprland rice.

Unsupported mutation semantics fail before the first backup or file change.

## Style Install

Both profiles manage Ghostty, Foot, and fish. Each command then manages only its selected desktop surface. A Plasma apply does not write Hyprland or Caelestia runtime paths; a Caelestia apply does not write KDE or Plasma paths. The stable copied source under `~/.local/share/tyrian-night/` contains generated assets for both profiles, but it is installer-owned data rather than live desktop configuration.

The theme family contract owns the selected desktop theme; it is currently Tyrian Abyss. Terminal configuration independently uses the catalog's appearance-specific defaults: Abyss for dark mode and Dawn for light mode. The installer derives its materialized assets, package identifiers, and Caelestia state from those owned roles rather than a hard-coded variant.

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

Every apply first copies the current state of each path it may change into a new backup under `~/.local/state/tyrian-night/backups/`. Each file, link, and directory is then replaced atomically, so no path is ever partial or missing. The install is deterministic: if an apply fails or is interrupted, running it again completes it. `desktop:recover` restores the latest backup exactly (including removing paths the install created) and deletes it, so repeated recovery steps back through earlier applies.

Ownership state is profile-scoped and retains each profile's XDG roots, so moving XDG configuration does not orphan the previous generation. If no ownership manifest exists, the installer only records its current outputs; it does not migrate or clean up historical paths.

## Full Rice

The full rice always uses the Plasma profile. It includes the style install and replaces:

- `$XDG_CONFIG_HOME/plasma-org.kde.plasma.desktop-appletsrc`;
- `$XDG_CONFIG_HOME/plasmashellrc`;
- current Plasma panel placement and sizing state;
- current desktop wallpaper state.

It stops and restarts Plasma shell while publishing the layout. Install every declared widget before apply; the installer validates required commands but Plasma itself owns widget package discovery.

Style installation, layout installation, and capture share the same XDG root resolver. `XDG_CONFIG_HOME` defaults to `~/.config`; configured roots must remain inside the selected home. Portable layout manifests retain their logical `.config/` keys regardless of the live config root.

```sh
# Read-only plan.
bun run rice

# Style, layout, panel, and wallpaper apply.
bun run rice:apply

# Roll back an interrupted Plasma run, or else undo the latest backup.
bun run rice:recover
```

The style is installed first, as above. The layout then has its own backup, including the previous panel and wallpaper state, and is published with Plasma stopped, because a running shell rewrites its layout on exit. If the restarted shell does not reach the requested panel and wallpaper state, the layout backup is restored and the previous state reapplied; the style stays installed. A crash while Plasma is stopped leaves a lifecycle record, and the next rice command rolls that layout back before doing anything else. `rice:recover` undoes one step at a time: an interrupted Plasma run first, then the latest layout or style backup.

## Capture Maintainer State

Layout capture is a repository-maintainer command, not installation preview. It briefly stops Plasma, captures portable layout state, verifies shell restoration, validates the whole snapshot, and only then replaces the tracked `rice/` files atomically. Git is the snapshot's history: review a capture with `git diff rice/` and undo it with `git checkout -- rice/`.

```sh
bun run rice --capture-layout
```

## Ownership

`apps/desktop/package.json` owns the desktop product version and runtime floor; the installers live in `apps/desktop/src` and run through the root `desktop:*` and `rice*` scripts. Shared theme roles remain owned by `source/`; generated terminal and desktop files are projections.
