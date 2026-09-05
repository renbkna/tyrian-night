# Tyrian Night Desktop Installer

This product installs shared Tyrian terminal files plus exactly one explicit desktop profile into one Linux user account. The profiles are KDE Plasma 6 or Caelestia on Hyprland. It is invasive configuration management, not a portable editor theme.

## Support Contract

The installer supports Linux systems that provide:

- Node.js 22.19 or newer;
- `/proc/self/fd` descriptor paths;
- GNU `mv` with `--exchange`;
- user-owned XDG configuration, data, and state roots inside the selected home directory.

The Plasma profile manages Plasma 6 configuration. The installer does not branch on `XDG_SESSION_TYPE`, so it does not claim a separate Wayland or X11 contract. The full rice additionally requires an active `plasma-plasmashell.service`, `qdbus6`, `kscreen-doctor`, `systemctl`, and the widgets in [`../../rice/plasma-layout/requirements.md`](../../rice/plasma-layout/requirements.md).

The Caelestia profile requires an existing Caelestia/Hyprland setup. It publishes Caelestia color state, terminal sequences, and the selected Hyprland scheme module. It does not install Caelestia, replace Caelestia's own Fastfetch or Starship configuration, configure the main Hyprland file, or provide a Hyprland rice.

Unsupported mutation semantics fail before a transaction is allocated.

## Style Install

Both profiles manage Ghostty, Foot, and fish. Each command then manages only its selected desktop surface. A Plasma apply does not write Hyprland or Caelestia runtime paths; a Caelestia apply does not write KDE or Plasma paths. The stable copied source under `~/.local/share/tyrian-night/` contains generated assets for both profiles, but it is installer-owned data rather than live desktop configuration.

The theme family contract owns the selected desktop theme; it is currently Tyrian Nocturne. Terminal configuration independently uses the catalog's appearance-specific defaults: Nocturne for dark mode and Dawn for light mode. The installer derives its materialized assets, package identifiers, and Caelestia state from those owned roles rather than a hard-coded variant.

```sh
# Read-only Plasma plan, then transactional apply.
bun run desktop:plasma:preview
bun run desktop:plasma:apply

# Read-only Caelestia plan, then transactional apply.
bun run desktop:caelestia:preview
bun run desktop:caelestia:apply

# Recover an interrupted apply.
bun run desktop:recover
```

Preview reads repository and destination state only. It does not generate ignored assets, create locks, publish configuration, or recover a previous transaction. Apply generates required projections before mutation.

For Caelestia, the installer asks the active Hyprland instance for `configProvider` with `hyprctl -j status`. Provider `lua` selects `current.lua`; provider `hyprlang` selects legacy `current.conf`. File presence is not provider detection. For an offline install or a different destination home, select the contract explicitly:

```sh
bun run desktop:caelestia:apply --hyprland-mode=lua
# or
bun run desktop:caelestia:apply --hyprland-mode=legacy
```

The default apply copies stable assets under `~/.local/share/tyrian-night/`; the checkout can then be moved or deleted. `--link` is only for development when live stable assets should follow the checkout:

```sh
node scripts/installLiveTyrian.mjs --target=plasma --apply --link
```

Backups are stored under `~/.local/state/tyrian-night/backups/`. Failed non-interrupted operations roll back immediately. A deliberately simulated or real process interruption preserves recovery evidence; run the explicit recovery command before another preview if you want the prior generation restored. Ownership state is profile-scoped v3 data and retains each profile's XDG roots, so moving XDG configuration does not orphan the previous generation. If no ownership manifest exists, the installer only records its current outputs; it does not migrate or clean up historical paths.

Both copy and link mode publish the installer-owned source directory as a complete generation. Transaction pointers use v4 and snapshots use v6: they distinguish published paths from disposable staging paths admitted absent before mutation. Recovery discards incomplete staging, preserves external changes to published paths, and accepts either the last completed write or its pending replacement. Existing v3 pointers and v5 snapshots remain recoverable; only their known generated staging names receive disposable-path treatment.

Recovery revokes old publication filenames before inspecting live targets and records fresh filenames for each retry. This prevents a surviving `mv` child from publishing after its parent dies. Directory deletion similarly retires the complete generation before removing its contents. Legacy v5 snapshots with unrecorded temporary publication files require reconciliation before recovery can proceed; those files are retained because their ownership and publisher lifetime cannot be proved from the old record.

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

# Transactional style, layout, panel, and wallpaper apply.
bun run rice:apply

# Recover an interrupted filesystem and Plasma lifecycle generation.
bun run rice:recover
```

One transaction owns the complete generation. Files are recovered before external Plasma state, and a successful apply is reported only after the requested panel and wallpaper state verifies.

## Capture Maintainer State

Layout capture is a repository-maintainer command, not installation preview. It briefly stops Plasma, captures portable layout state, verifies shell restoration, and writes the repository snapshot:

```sh
bun run rice --capture-layout
```

## Ownership

`apps/desktop/package.json` owns the desktop product version, Linux admission, runtime floor, and commands. Shared theme roles remain owned by `source/`; generated terminal and desktop files are projections.
