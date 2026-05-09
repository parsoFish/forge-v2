---
initiative_id: INIT-2026-05-08-healarr-readme
project: healarr
project_repo_path: projects/healarr
created_at: 2026-05-08T10:00:00Z
iteration_budget: 10
cost_budget_usd: 4
phase: in-flight
features:
  - feature_id: FEAT-1
    title: Update README with new auth flow notes
    depends_on: []
  - feature_id: FEAT-2
    title: Add troubleshooting page for 401 errors
    depends_on: []
---

# README + troubleshooting docs refresh

## Why

Last week's auth refactor changed how clients pass session tokens (cookie → bearer header). The README still describes the cookie flow, and users hitting the new 401 errors don't have a troubleshooting page to land on.

This is **a small documentation initiative**. The PM should resist the temptation to decompose it into more work items than there are real units of writing — over-decomposition is a known failure mode (50 work items for a 3-day feature). Two work items, one per page, is the right shape.

## Scope

- `README.md` — replace the cookie-flow auth section with the bearer-header flow.
- `docs/troubleshooting/401-errors.md` (new) — list common causes, link from README.

## Out of scope

- Any code change.
- Other docs pages.
- Translations.

## Acceptance

- README's auth section accurately describes bearer-header flow.
- Troubleshooting page covers: clock skew, expired token, missing scope, replayed token from another deployment.
- README links to troubleshooting page from the auth section.
- Each page is independently editable — neither work item should depend on the other.
