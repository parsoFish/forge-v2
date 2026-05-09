# healarr

Self-hosted health tracker. Stores BP/HR/SpO2 readings locally; exposes a small REST API for
sync from a phone app.

## Auth

API tokens in `~/.healarr/auth.json`. The token is sent as `Authorization: Bearer <token>`.

## Features

- BP / HR / SpO2 reading capture (`POST /readings`).
- Per-tag history (`GET /readings?tag=<name>`).
- Daily roll-up (`GET /summary?date=<iso>`).
- Local-first: no cloud dependency.

## Quick start

Install:

```
go install ./cmd/healarr
```

Run:

```
healarr serve --port 8080
```

Then `curl -H "Authorization: Bearer dev" http://localhost:8080/readings` returns the captured
readings as JSON. See `docs/index.md` for the full REST surface.
