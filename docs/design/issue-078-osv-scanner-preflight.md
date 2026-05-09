# Issue 78 OSV-Scanner CI Preflight

Date: 2026-05-09

Issue 78 adds OSV-scanner as an advisory CI job for the root
`pnpm-lock.yaml`. This is workflow hardening, not a runtime feature.

## Existing Contracts

- `.github/workflows/ci.yml` is the CI surface. Add a separate job
  there; do not create a second workflow for this check.
- ADR-009 owns toolchain choices: Node 22, pnpm 9.15, single package,
  root `pnpm-lock.yaml`, and package-script vocabulary.
- `.ground-control.yaml` `workflow.*` commands remain the local
  completion gate. OSV is GitHub CI advisory coverage, not part of the
  local completion command unless that policy is changed explicitly.
- Existing security checks keep their boundaries:
  - `gitleaks` finds committed secrets.
  - `pnpm audit --prod` runs npm advisory coverage for production deps.
  - SonarCloud is the hard code-quality gate.
  - OSV-scanner adds OSV.dev advisory coverage for the npm dependency
    tree resolved by `pnpm-lock.yaml`.

## Guardrails

- Scope scanner input to the repo-root `pnpm-lock.yaml`. Do not scan
  source directories, generated output, coverage, or future workspace
  directories until the dependency surface changes.
- Keep the job advisory initially. It should upload JSON or SARIF as an
  artifact and should not block merges on findings.
- Preserve least privilege. The workflow only needs repository read
  access plus any permission strictly required by the chosen artifact or
  SARIF upload path.
- Prefer a pinned, maintained OSV-scanner GitHub Action or pinned binary
  install path. Avoid unpinned install scripts.
- Use deterministic artifact naming and short retention, consistent with
  the existing `coverage` artifact retention.
- Do not add Trivy. The issue explicitly excludes it because this repo
  has no first-party container image or IaC scanning surface.

## Gotchas

- SARIF upload may require `security-events: write`; JSON artifact upload
  does not. Do not expand workflow permissions if JSON satisfies the
  acceptance criteria.
- Some OSV invocations exit non-zero when vulnerabilities are found.
  Advisory mode must handle that deliberately while still failing on
  scanner execution errors where the action supports that distinction.
- `pnpm audit --prod` and OSV are overlapping but not interchangeable.
  Do not remove or weaken the existing dependency-audit job as part of
  this issue.
- Do not install dependencies just to scan the lockfile unless the chosen
  scanner path requires it. The contract is lockfile analysis.

## Non-Goals

- No source changes, runtime abstractions, schemas, DTOs, services,
  repositories, exception hierarchies, logging changes, or persistence
  changes.
- No new package script or Ground Control workflow command unless
  maintainers decide OSV should become a local gate.
- No merge-gating policy for vulnerabilities in this issue.
- No container, IaC, filesystem, secret, license, or vendored-code
  scanning expansion.
