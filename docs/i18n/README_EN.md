# Ruyi Localization Guide

This is the English companion to [多语言兼容方案](README.md). Ruyi currently ships Simplified Chinese and English
while preserving stable extension points for future BCP 47 locales.

## Runtime and catalogs

The zero-dependency browser runtime in app/public/js/i18n.js provides locale normalization, browser-language
detection, named interpolation, plural selection, fallback, and data-i18n/data-i18n-attr DOM application.

The documented source-of-truth catalogs are docs/i18n/locales/zh-CN.json and en-US.json. Identical copies are
published with the application under app/public/locales. Both language pairs must have exactly the same key and
placeholder sets.

The locale configuration accepts auto, zh-CN, and en-US. Auto resolves the browser language on first use and
persists the result. The UI updates html lang and locale-aware date, number, and time formatting.

## Current coverage

- Settings, Provider cards (including pricing and context windows), model switching, safety and capability popovers,
  artifacts, tool-call summaries, shortcuts, the command palette, brand status, first-run/empty states, and the skill
  library redraw when the locale changes. A non-bottom chat reading position is retained during a locale redraw.
- Built-in skills, commands, quick tasks, and the “save as playbook” editor use catalog metadata for their names,
  descriptions, and built-in quick-task fields. Fixed capability-unavailability reasons are translated for built-in,
  user, and project items; user and project-authored SKILL.md or quick-task content remains in its original language
  rather than being treated as product copy.

## Authoring rules

- Use semantic, lower-case dotted keys such as workspace.switch.success.
- Use named placeholders only, for example {{directory}}.
- Keep free text, model output, paths, tool names, and sensitive values out of catalog keys.
- Call t() while creating dynamic DOM. Use data-i18n only for stable static DOM.
- Re-render stateful views when the language changes; do not mix languages in one view.

## API errors

Every HTTP error response now uses an error object with code, params, and optional diagnostic message. Clients map
stable codes to catalog keys. Legacy string errors are automatically wrapped in the generic api.request_failed
code during migration; the message remains available for diagnostics and older callers.

## Quality gates

The i18n static E2E checks catalog parity, placeholder parity, runtime fallback, DOM attributes, pluralization,
structured and legacy error normalization, and locale configuration. The integration E2E verifies packaged catalogs
and locale persistence against a real local server. Pseudo-localization expands every English resource while
preserving placeholders to expose clipping and concatenation problems.

Browser screenshot regression remains a follow-up where the browser automation runtime is available.
