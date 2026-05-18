Towncrier-managed changelog fragment workflow — issue 91 — in
`towncrier.toml`, `changelog.d/_template.md.jinja`,
`changelog.d/README.md`, `CHANGELOG.md`, `.gitattributes`, and
`.gc/plan-rules.md`: PRs now drop a fragment under
`changelog.d/<issue>.<type>.md` (or `+<slug>.<type>.md` for orphan /
meta entries) instead of hand-editing `CHANGELOG.md`. Release-time
`towncrier build` collates fragments into a Keep-a-Changelog-shaped
release section below the new `<!-- towncrier release notes start -->`
marker. The six fragment types (`security`, `removed`, `deprecated`,
`added`, `changed`, `fixed`) render in that order; the custom Markdown
Jinja template produces `## [X.Y.Z] - DATE` / `### Section` /
`- bullet (#issue)`. `.gitattributes` marks `CHANGELOG.md merge=union`
as defense in depth on top of the fragments themselves. Existing
`### Added`-headed fragments (41, 46, 47, 49, 56, 57, 58, 77) are
normalized to canonical content-only shape so the new template
produces clean output instead of duplicate nested headings. No
runtime source change, no new CI gate (the companion
workflow-standardization issue owns `towncrier check`), no towncrier
JS dependency, no automatic publishing.
