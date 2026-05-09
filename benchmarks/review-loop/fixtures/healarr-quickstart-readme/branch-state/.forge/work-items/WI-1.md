---
work_item_id: WI-1
feature_id: FEAT-1
initiative_id: INIT-2026-05-09-healarr-quickstart-readme
status: complete
depends_on: []
acceptance_criteria:
  - given: "the README at the project root"
    when:  "a reader scans the top-level headings"
    then:  "a Quick start section appears that names the install and run commands"
  - given: "the README at the project root"
    when:  "a reader scans the body"
    then:  "the install and run instructions reference healarr-specific commands (not generic placeholders)"
  - given: "the existing README sections (Auth, Features)"
    when:  "the README is rendered"
    then:  "those sections remain present alongside the new Quick start section"
files_in_scope:
  - README.md
estimated_iterations: 1
---

# WI-1: Add Quick start section to README

The healarr README documents the Auth and Features sections but has no install / run instructions
for first-time users. Add a `## Quick start` section that walks through `go install` + `healarr serve`
and a sample `curl` call.

## Status: complete

- New `## Quick start` section in `README.md` with install + run + curl example.
- Existing `## Auth` and `## Features` sections preserved.
- The first-impression friction for new users drops from "where do I start?" to one paste-able command sequence.
