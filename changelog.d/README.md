# Changelog fragments

This directory holds the per-PR changelog fragments that
[towncrier](https://towncrier.readthedocs.io/) collates into
`CHANGELOG.md` at release time. **Do not edit `CHANGELOG.md` directly**
except as part of a release-collation commit — that commit by definition
touches only `CHANGELOG.md` and the fragments it consumed.

## Why fragments

Hand-edited top-of-`CHANGELOG.md` entries cause guaranteed merge
conflicts whenever two PRs are open at once. Rebasing to clear the
conflict re-runs the full CI workflow on the PR. Fragments live in
their own files, so they never collide, they never trigger a
rebase-just-for-changelog cycle, and they cost nothing in CI minutes
to keep up to date.

`.gitattributes` also marks `CHANGELOG.md merge=union` as
defense-in-depth, but the workflow — fragments per PR — is what
actually prevents the conflict.

## Naming

Each fragment file is named `<issue-or-pr-number>.<type>.md`:

- `<issue-or-pr-number>` matches the GitHub issue this PR closes (or
  the PR number if the change is genuinely issue-less).
- `<type>` is one of:
  - `security` — vulnerability fix or hardening.
  - `removed` — a removed feature or removed public surface.
  - `deprecated` — a feature still present but slated for removal.
  - `added` — a new feature or new public surface.
  - `changed` — a change in existing behavior.
  - `fixed` — a bug fix that is not a security fix.

For orphan / meta entries that do not have an issue or PR number to
anchor against (release-tooling adoption, repo housekeeping, etc.),
use the `+`-prefixed form:

```
+<unique-slug>.<type>.md
```

The `+` prefix is towncrier's documented convention for orphan
fragments and prevents collisions with future numbered fragments.

Examples:

```
91.added.md
142.fixed.md
+towncrier-adoption.added.md
+release-script-cleanup.changed.md
```

## Content shape

Each fragment file holds the **bullet content directly** — the body
becomes one bullet under the section heading at release time. The
template emits the section heading (`### Added`, `### Fixed`, etc.)
and the bullet marker (`- `); the fragment body must not repeat them.

Correct:

```
PUL-F031 workbench chrome surface. The runtime now mounts a
workbench-owned chrome DOM root (`<div data-pulsar-chrome="surface">`)
as a sibling of `#stage` before the first navigation event, governed
by the active workbench mode, and persistent across scene navigations
within a composition.
```

Incorrect (produces duplicate nested heading at release time):

```
### Added

- PUL-F031 workbench chrome surface. ...
```

Multi-paragraph fragments are fine — towncrier preserves blank lines
and indents continuation text under the bullet. Sub-bullets are also
fine; indent them with two spaces.

## Building a release section locally (preview)

Towncrier is a Python CLI; pulsar does not bundle it. To preview the
release section a `towncrier build` would write, run:

```
pipx run towncrier build --version X.Y.Z --date YYYY-MM-DD --draft
```

`--draft` prints the generated section to stdout without modifying
`CHANGELOG.md` or removing the consumed fragments — safe to run from
any working tree. Drop the flag when actually cutting a release:

```
pipx run towncrier build --version X.Y.Z --date YYYY-MM-DD --yes
```

That command writes the new section into `CHANGELOG.md` just below the
`<!-- towncrier release notes start -->` marker and deletes the
consumed fragment files in one operation. Commit the result as the
release-collation commit.

Release version and date are CLI arguments, never hardcoded in
`towncrier.toml` or the template. Future automation (release script
or CI job) should layer on those parameters; do not bake fixed values
into config.

## Anti-patterns

- Do **not** add a second changelog generator, release-notes script,
  or a duplicate fragment taxonomy in `package.json`.
- Do **not** duplicate towncrier config in `pyproject.toml` or
  `package.json` — the single source of truth is `towncrier.toml` at
  the repo root.
- Do **not** add towncrier as a JavaScript dependency. It is an
  external Python release tool, invoked manually (or by a separate
  release script) at release time, not by the runtime build.
- Do **not** edit fragments in `CHANGELOG.md` after release-collation
  has written them; further edits go through a new fragment in a new
  PR.
