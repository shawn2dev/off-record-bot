# Off Record Project Guidelines

## User-Facing Language

- Use Korean for all Off Record bot and dashboard UI: Discord command names,
  descriptions, options, embeds, buttons, menus, validation and error messages.
- Korean is the default for every client locale; do not fall back to English
  command names or UI copy when Discord or the browser uses English.
- Keep visible strings in Korean display resources. The bot resource is
  [src/xp-locale-ko.js](src/xp-locale-ko.js). Extend it for new bot features.
- Keep code identifiers, comments, operational logs, test descriptions and
  documentation in English. Korean translation values and expected UI text in
  tests are intentional exceptions.
- Preserve user-provided names and identifiers rather than translating them.
- Test Korean command/option routing and normal, empty and error display states.

These language rules apply to the Off Record project, not unrelated projects.