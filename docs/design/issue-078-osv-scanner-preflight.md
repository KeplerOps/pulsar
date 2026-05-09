# Issue 78 OSV-Scanner CI Preflight

Date: 2026-05-09

Issue 78 adds OSV-scanner as a blocking CI job for the root
`pnpm-lock.yaml`. This is workflow hardening, not a runtime feature.

Note: the original issue body scoped the job as "advisory (no merge
gate initially)." During implementation review the maintainer
elected to ship the gate as blocking from day one. The issue body
is left unchanged for historical fidelity; this document records the
shipped behavior.

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
- Block merges on findings. Vulnerability exit (1) and any
  scanner/tooling exit (non-zero, non-1) fail the job. The artifact
  uploads on every outcome so triage starts from the failed run, not
  from a fresh local re-scan.
- Mark the `OSV-Scanner` check as a required status check on `main`
  and `dev` branch protection rules so the gate is enforced at merge
  time, not just at job-status level.
- Preserve least privilege. The workflow only needs repository read
  access. JSON output avoids the `security-events: write` expansion
  SARIF upload would require.
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
- OSV-scanner exits 1 when vulnerabilities are found and uses other
  non-zero exits for scanner/tooling errors. Both are failure modes
  for a blocking job, but the wrapper must distinguish them so the
  GitHub annotation tells reviewers which case fired (`vulnerabilities`
  vs. `scanner error`).
- GitHub Actions wraps `run:` with `bash -eo pipefail` by default. A
  bare `./osv-scanner ...` call exits the shell on the vuln-exit code
  before any wrapper logic runs. Capture the exit code with
  `cmd || rc=$?` (errexit-safe) so JSON validation runs regardless of
  scan outcome.
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
- No suppression / waiver / triage policy in this issue. When a
  legitimately accepted CVE needs to pass the gate, that is the
  trigger to add an explicit suppression mechanism (e.g., an
  ignored-vulns config consumed by the scanner) — not to relax the
  gate.
- No container, IaC, filesystem, secret, license, or vendored-code
  scanning expansion.
