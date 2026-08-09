# Tyrian Night

Tyrian Night is one visual system exported to independently supported editor, terminal, and Linux desktop products. Neutral theme roles live in `source/`; consumer files are generated projections.

## Products and Support

| Product | Supported systems | Mutation level | Product contract |
|---|---|---:|---|
| VS Code color themes | VS Code 1.118+ on Linux, macOS, and Windows | Standard extension install | [`apps/vscode/README.md`](apps/vscode/README.md) |
| VS Code Island UI | Linux only | Patches the VS Code application | [`apps/vscode/README.md#island-ui`](apps/vscode/README.md#island-ui) |
| Zed themes | Systems supported by Zed | Standard theme extension | [`apps/zed/README.md`](apps/zed/README.md) |
| Terminal and desktop files | Wherever each target accepts them | User-selected files | Component README files |
| Live desktop installer | Linux with `/proc` and GNU `mv --exchange` | Replaces user configuration transactionally | [`apps/desktop/README.md`](apps/desktop/README.md) |
| Full rice installer | Linux, KDE Plasma 6, and declared commands/widgets | Replaces Plasma layout and restarts Plasma | [`apps/desktop/README.md#full-rice`](apps/desktop/README.md#full-rice) |

The workspace requires Bun 1.3.11 and Node.js 22.19 or newer. Product manifests own narrower runtime requirements.

## Family

The six variants are intentionally different expressions of the same semantic system rather than near-duplicate palettes.

| Theme | Visual center | Purpose |
|---|---|---|
| **Tyrian Night** | Quiet plum-black and low-energy | Nocturne's violet, cobalt, indigo, and rose grammar with lower chroma, softer contrast, and calmer plum surfaces |
| **Tyrian Nocturne** | Tempered cosmic and nocturnal | Default family center: restrained ultraviolet identity, cobalt functions, indigo structure, rose data, and controlled plum-black depth |
| **Tyrian Pastel** | Velvet plum and soft-focus | Independent soft-focus branch with related categorical hues, gentle pigments, and layered plum surfaces |
| **Tyrian Abyss** | Near-black cosmic nebula | Nocturne pushed darker and more chromatic, with stellar cobalt and ultraviolet structure on deep-space indigo |
| **Tyrian Dawn** | Near-white and ink-dark | Light translation of Nocturne with the same categorical syntax, hierarchy, and interaction behavior |
| **Tyrian Night Old** | Historical reference | Frozen earlier low-chroma palette translated through the current schema-v5 bindings, opacity policy, and safety gates |

Purple owns identity, focus, keywords, and selected emphasis. It does not replace warm errors, amber warnings and regular expressions, green strings and success, dusty-blue functions, smoky-indigo structural types, cool-rose data, or blue information. Green-through-cyan hues are reserved for strings, success-derived states, hints, and ANSI green; they are excluded from other code and UI roles. Terminal ANSI names remain protocol slots; each theme owns their rendered material.

Bracket nesting uses a dedicated six-depth palette rather than borrowing syntax or UI accents. Because depth colors carry independent state, the safety contract prevents exact color collapse. Normal and simulated color-space distances remain diagnostics; they do not choose the atmosphere.

## Palette

Tyrian Nocturne is the selected default and semantic base. Night, Nocturne, and Abyss share one exact hue profile; their recipes author explicit per-role OKLCH lightness and chroma. Night stays within 60–70% of Nocturne's mean semantic chroma, Nocturne is the 100% center, and Abyss stays within 130–145% with roughly 0.19–0.20 mean semantic chroma and higher syntax contrast. Pastel and Dawn use related branch hue profiles. The shared opacity contract owns role alpha. WCAG contrast is a hard minimum readability gate, and independent states may not resolve to the same rendered color. These rules catch real failures without pretending to choose a beautiful palette.

OKLCH, OKLab distance, color-vision simulation, and gamut-relative pigment richness are author diagnostics. Richness is `rho = C / Cmax(L, h, sRGB)`, which distinguishes an intentionally deep pigment from an accidentally gray one at the same lightness and hue. None of these observations is an attention, comfort, harmony, or quality score. The green-through-cyan reservation is explicit Tyrian brand policy, not a scientific law.

Family hue profiles, canonical default, and each variant's appearance classification are edited only in `source/themeFamilyContract.json`; per-variant lightness and chroma are edited only in the matching schema-v5 recipe, such as `source/themes/tyrian-nocturne.json`. Generated VS Code, Zed, terminal, desktop, and production-preview files are projections and never become palette inputs. Human design judgment happens in the real editors using the compact scenes in [`examples/theme-preview`](examples/theme-preview/README.md): important code should read clearly, comments and punctuation should recede without disappearing, active errors/search/selection should interrupt appropriately, and the result should remain comfortable during ordinary work.

Blue functions, salmon errors, cool-rose data, and cool structural types remain separate categories in the current projections and diagnostics. ANSI red retains the error category.

## Interaction Contract

The component and workbench state language is shared across products:

- Hover changes the local surface and may add a low-chroma neutral border.
- Pressed uses a stronger active surface.
- Checked or selected uses a persistent low-chroma accent surface.
- Keyboard focus adds an outline without replacing hover, press, selection, or validation state.
- Saturated accent is reserved for keyboard focus, primary actions, progress, and compact indicators; destructive actions retain semantic red.
- Small radii belong to indicators, medium radii to controls and rows, and large radii to cards, dialogs, and popups.

The VS Code projection maps these states explicitly for toolbar actions, checkboxes, radios, input options, the action bar, status-bar items, command center, chat, notebooks, tests, and current agent UI. High-contrast-only defaults such as `contrastBorder` remain unset so normal themes do not acquire duplicate outlines.

## Editor Installation

Install **Tyrian Night** from the VS Code Extensions panel, then select a variant with **Preferences: Color Theme**. Tyrian Nocturne is the repository and companion-settings default; VS Code still requires the user to select a theme. Island UI is a separate opt-in Linux feature; installing a color theme does not patch VS Code.

There is one VS Code extension download. It contains the color themes and the optional Island UI feature; Island is not a second extension.

For Zed, install the extension from `apps/zed/` or follow its product README.

## Desktop Commands

Desktop preview commands are observational: they read repository and destination state, print the plan, and do not generate files, acquire mutation locks, or recover interrupted transactions.

```sh
bun run desktop:plasma:preview
bun run desktop:plasma:apply

bun run desktop:caelestia:preview
bun run desktop:caelestia:apply

bun run desktop:recover
bun run rice
bun run rice:apply
bun run rice:recover
```

Read the desktop product contract before applying it. The full rice is not a generic theme installer.

## Authority and Repository Layout

- `source/themeRoleContract.json` owns role membership.
- `source/themeCatalog.json` owns ordered family membership and per-appearance terminal defaults.
- `source/themeColorBindings.json` owns explicit role aliases and alpha derivations; unlisted roles self-own one opaque pigment.
- `source/themeOpacityContract.json` owns one family opacity policy, with explicit appearance-only overrides.
- `source/themeFamilyContract.json` owns the canonical/default theme, semantic pigment vocabulary, hue profiles, variant appearance classifications, energy envelopes, and branch hue limits.
- `source/themePigmentPolicy.json` owns the family-wide green-through-cyan reservation over resolved semantic roles: strings, success-derived states, hints, and ANSI green are allowed.
- `source/themes/` owns explicit per-role OKLCH lightness and chroma for every schema-v5 variant; the family contract freezes the Tyrian Night Old palette while current bindings continue to project it.
- `source/themeSafetyContract.json` owns hard rendered-contrast and state-identity requirements and applies automatically to every catalog theme.
- `scripts/colorScience.mjs` owns policy-free sRGB, contrast, OKLab/OKLCH, distance, and richness observations.
- `examples/theme-preview/` owns the small real-editor inspection corpus and a generated production-family workbench; it is guidance, not a scored approval system.
- `source/union-css/` owns reusable component geometry and interaction rules.
- `scripts/projections/` owns consumer-specific key and grammar mappings.
- `apps/vscode/` owns the VS Code manifest, build, runtime, package contents, and support contract.
- `apps/zed/` owns the Zed extension.
- `apps/desktop/` owns the Linux installer version, commands, and support contract.
- `terminal/`, `desktop/`, and `rice/` contain generated or captured product assets.

Generated consumers never become palette inputs.

## Development

```sh
bun install --frozen-lockfile
bun run color:audit
bun run color:audit -- --theme=tyrian-nocturne --diagnostics
bun run verify
bun run package:vscode
```

`color:audit` reports accessibility and brand-policy failures separately. The opt-in diagnostics expose contrast, OKLCH, richness, and normal/simulated state distances without assigning them a quality score. Use the real-editor preview scenes for atmosphere, hierarchy, glare, and comfort; those judgments cannot be reduced to a repository score.

CI packages the static VS Code product on Linux, macOS, and Windows. Linux additionally runs the Island mutation proofs and desktop installer proofs.

## Contributing

Found a language, scope, or component state that needs work? [Open an issue](https://github.com/renbkna/tyrian-night/issues).

## License

[Apache License 2.0](LICENSE) © [renbkna](https://github.com/renbkna)
