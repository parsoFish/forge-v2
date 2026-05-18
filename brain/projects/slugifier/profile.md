---
project: slugifier
created_at: 2026-05-17T02:41:01Z
updated_at: 2026-05-17T02:41:01Z
---

# Project: slugifier

## What / why

A shared canonical URL-safe slugifier package for a content pipeline. Two independent callers (index builder + link renderer) maintained divergent slug logic, causing dead links. This package is the single source of truth they both import.

## Stack

- TypeScript / Node.js
- `npm test` — Node built-in test runner (TAP output)
- ESM modules

## Hard constraints

- Pluggable transliteration tables: **out of scope**
- Locale-aware lowercasing (Turkish dotless-i): **out of scope**
- Corpus-persisted uniqueness (database-backed dedup): **out of scope**

## Key contacts

_None recorded — new project as of Cycle 1._

## Cycles

- **chained-INIT-2025-05-17-slugifier-package-1778984667230** — inaugural cycle; built core slugify + batch helpers + configurable options.
