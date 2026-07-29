# Theme preview

Open these files with the normal Tyrian Night product in VS Code and Zed after changing a source
theme. They cover dense syntax, literals, documentation, diagnostics, search, and selection without
claiming that a metric predicts attention or comfort.

For family design work, open [`zed-family-lab.html`](zed-family-lab.html) in a browser. Every card is
generated at runtime from `generated/production-family.js`, the projection produced by
`scripts/themePreview.mjs`; the page does not maintain a second palette definition. Each card
uses the same fixed editor and terminal scene so current catalog recipes can be compared directly.

Check the recipe against the current production theme:

- primary code is immediately readable;
- comments and punctuation recede without becoming hard to inspect;
- errors, active search, and selection interrupt syntax when their editor state is active;
- semantic pigments remain recognizable and do not look accidentally gray;
- the theme remains comfortable during ordinary work; and
- you prefer the recipe in both editors.

The color audit owns automated accessibility and brand checks. This preview owns the human design
decision; it is deliberately not a scored gate.
