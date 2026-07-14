# Tyrian Night

Tyrian Night is one semantic color system exported to VS Code, Zed, terminals, KDE Plasma, Union, and Caelestia. Neutral roles live in `source/`; every product file is a generated projection.

## Family

The dark variants deliberately occupy different visual centers instead of averaging into one compromise:

- **Tyrian Night** — neutral-black and quiet; the canonical default.
- **Tyrian Nocturne** — visibly purple and atmospheric, with tonal controls.
- **Tyrian Abyss** — OLED-black and electric, with the highest accent chroma.
- **Tyrian Dawn** — the light counterpart, retaining the same categorical hue grammar.
- **Tyrian Night Old** — the unchanged legacy comparison preset.

All current variants share the same semantic anchors: Tyrian purple for accent and keywords, blue for types and information, teal for functions and ANSI cyan, green for strings and success, rose for data, amber for regular expressions and warnings, and red for errors. This prevents syntax and terminal categories from collapsing into status signals.

## Products and Support

| Product | Supported systems | Mutation level | Product contract |
|---|---|---:|---|
| VS Code color themes | VS Code 1.118+ on Linux, macOS, and Windows | Standard extension install | [`apps/vscode/README.md`](apps/vscode/README.md) |
| VS Code Island UI | Linux only | Patches the VS Code application | [`apps/vscode/README.md#island-ui`](apps/vscode/README.md#island-ui) |
| Zed themes | Systems supported by Zed | Standard theme extension | [`apps/zed/README.md`](apps/zed/README.md) |
| Terminal and desktop files | Wherever the target application supports them | User-selected files | Component README files |
| Live desktop installer | Linux with `/proc` and GNU `mv --exchange` | Replaces user configuration transactionally | [`apps/desktop/README.md`](apps/desktop/README.md) |
| Full rice installer | Linux, KDE Plasma 6, and the declared commands/widgets | Replaces Plasma layout and restarts Plasma | [`apps/desktop/README.md#full-rice`](apps/desktop/README.md#full-rice) |

The workspace requires Bun 1.3.11 and Node.js 22.19 or newer. Product manifests own narrower runtime requirements.

## Palette

Tyrian Night’s default palette is generated from neutral roles. Primary text is AAA, current supporting text and syntax are AA, and category separation is guarded with OKLab distance and complete-dichromacy simulation tests.

| Role | Hex | Ratio | Level |
|:-----|:-----|------:|:------|
| Canvas | `#0C0C0C` | — | — |
| Reading / hover surface | `#262330` | — | — |
| Primary text | `#CDC7D9` | 11.89:1 | AAA |
| Muted supporting text | `#7F7E91` | 4.93:1 | AA |
| Keywords / accent | `#A17ADF` | 5.93:1 | AA |
| Types / information | `#78A5EF` | 7.85:1 | AA |
| Functions / cyan | `#41B2B2` | 7.67:1 | AA |
| Strings / success | `#649C66` | 6.04:1 | AA |
| Data literals | `#CF86B7` | 7.22:1 | AA |
| Regular expressions / amber | `#C1A057` | 7.86:1 | AA |

The redesigned variants enforce at least 20 OKLab points between function/cyan and error/red, and at least 10 points across function/string, keyword/type, and regexp/string pairs.

## VS Code Coverage

`scripts/projections/vscodeColors.json` owns the VS Code consumer contract. It maps 709 current workbench color IDs while retaining one owner per key. Coverage includes:

- distinct hover, pressed, checked, selected, and keyboard-focus states;
- checkbox, radio, input-option, toolbar, action-bar, and command-center toggles;
- chat, inline chat, agent status, notebooks, testing, gauges, settings, SCM, charts, and terminal suggestions;
- terminal search, selection, sticky scroll, command decorations, and overview-ruler states;
- semantic tokens, TextMate scopes, symbol icons, and debug values.

High-contrast-only borders and shadow colors remain unset so VS Code can preserve platform behavior.

## Union State Grammar

Union uses the same rule across controls, delegates, menus, tabs, views, and Kirigami components:

- hover changes the local surface;
- pressed uses a stronger active surface;
- checked or selected uses a persistent low-chroma accent surface;
- keyboard focus adds an outline without replacing semantic state;
- saturated fills are reserved for primary actions and compact indicators.

Shape scale is explicit: small radii for indicators, medium radii for controls and rows, and large radii for cards, dialogs, and popups.

## Authority and Repository Layout

- `source/themeRoleContract.json` owns role membership.
- `source/themeCatalog.json` owns family order and defaults.
- `source/themes/` owns neutral UI, syntax, effect, and ANSI values.
- `scripts/projections/` owns consumer-specific key and grammar mappings.
- `source/union-css/` owns component geometry and interaction behavior.
- `apps/vscode/`, `apps/zed/`, `terminal/`, and `desktop/` contain generated product assets.

Generated consumers never become palette inputs.

## Development

```sh
bun install --frozen-lockfile
bun run color:audit
bun run verify
bun run package:vscode
```

CI verifies generated ownership, TypeScript, linting, formatting, tests, VS Code packaging on Linux/macOS/Windows, and the Linux desktop installer proofs.

## License

[Apache License 2.0](LICENSE) © [renbkna](https://github.com/renbkna)
