# healarr

Self-hosted health tracker with API access. (Trivially-scaffolded fixture for the PM bench's small-surface case.)

## Layout

- `README.md` — public docs (auth flow, install, basic usage).
- `docs/` — supporting documentation.

## Auth (current — needs update)

Pass session token as a cookie:

```
curl --cookie "healarr_session=<token>" https://...
```

> ⚠️ **Stale.** The auth flow moved to bearer-header authentication last week. This section is the target of the active initiative.
