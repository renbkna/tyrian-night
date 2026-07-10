# Plasma Layout Requirements

This rice snapshot stores Plasma widget IDs, positions, and widget config. It does not vendor the
widget packages themselves.

Install these widgets before restoring the layout on a new machine, then apply the listed style
dependencies so the look and feel matches the Tyrian snapshot closely.

The restore command uses `qdbus6` to read Plasma state and apply the wallpaper,
`kscreen-doctor` to identify the primary display, and `systemctl` to stop and restart Plasma while
the layout files are replaced.

## Third-Party Widgets

| Plugin ID | Widget | Source |
|:--|:--|:--|
| `com.axzoros.yorhahud` | YoRHa HUD | <https://github.com/AxZoRos/YoRHa-HUD> |
| `luisbocanegra.audio.visualizer` | Kurve | <https://github.com/luisbocanegra/kurve> |
| `luisbocanegra.panel.colorizer` | Panel Colorizer | CachyOS/Arch package: `plasma6-applets-panel-colorizer`; upstream: <https://github.com/luisbocanegra/plasma-panel-colorizer> |
| `org.kde.olib.thermalmonitor` | Thermal Monitor | <https://invent.kde.org/olib/thermalmonitor> |
| `org.kde.plasma.catwalkr` | CatWalkR | KDE Store / local Plasma widget package |

## Style Dependencies

These theme assets are set by Tyrian's look-and-feel defaults but are typically provided by your KDE
environment or your distro package set. Install or confirm they are available before layout restore for
best visual parity:

- Application widget style: `Breeze`
- KDE decoration theme: `Breeze`
- Icons: `Papirus-Dark`
- Cursors: `Bibata-Modern-Classic`

## KDE Built-Ins

These are expected to come from a normal KDE Plasma install:

- `org.kde.desktopcontainment`
- `org.kde.panel`
- `org.kde.plasma.digitalclock`
- `org.kde.plasma.folder`
- `org.kde.plasma.icontasks`
- `org.kde.plasma.kickoff`
- `org.kde.plasma.minimizeall`
- `org.kde.plasma.panelspacer`
- `org.kde.plasma.systemtray`

## Updating This List

After changing widgets and recapturing the rice, compare the captured plugin IDs:

```sh
rg -n '^plugin=' rice/plasma-layout/config/plasma-org.kde.plasma.desktop-appletsrc
```

If a new third-party plugin appears, add it here so another machine can install the same widget
before running:

```sh
bun run rice --apply
```
