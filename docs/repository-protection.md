# Repository Protection

This public repository uses tracked GitHub governance files plus GitHub-side
branch settings to reduce accidental or malicious codebase changes.

## Tracked Controls

- `.github/CODEOWNERS` assigns all files to `@Geo-Li` for Code Owner review.
- `.github/workflows/ci.yml` runs typecheck, lint, tests, and a high-severity
  root dependency audit with read-only GitHub token permissions.
- `.github/dependabot.yml` opens dependency update PRs for root npm packages,
  `menubar/` npm packages, and GitHub Actions.
- `.github/pull_request_template.md` adds verification and security review
  checklists to every PR.
- `SECURITY.md` defines vulnerability reporting expectations.

## GitHub Settings

The `main` branch should be protected with:

- Pull request required before merge
- Code Owner review required
- At least one approving review
- Stale approvals dismissed after new pushes
- Last push approval required
- Required status check: `check`
- Conversation resolution required
- Force pushes disabled
- Branch deletion disabled

During early development, repository admins may bypass the rule for direct
owner pushes. Direct pushes cannot be blocked on CI before they land; CI runs
after the push and must be watched.

Actions should stay read-only by default and should allow only GitHub-owned
actions unless a PR explicitly justifies a broader action allowlist.
