---
work_item_id: WI-1
feature_id: FEAT-1
initiative_id: INIT-2026-05-09-gitweave-multipart-stub
status: complete
depends_on: []
acceptance_criteria:
  - given: "a body with two boundary-delimited segments"
    when:  "splitOnBoundary(body, 'BOUND') is called"
    then:  "an array with both parts is returned, in order"
  - given: "a body with no boundary markers"
    when:  "splitOnBoundary is called"
    then:  "an empty array is returned"
  - given: "a body whose final boundary is the closing marker (--BOUND--)"
    when:  "splitOnBoundary is called"
    then:  "the closing marker is ignored and not emitted as a part"
  - given: "a part with internal whitespace"
    when:  "splitOnBoundary is called"
    then:  "the internal whitespace is preserved (not collapsed)"
files_in_scope:
  - src/multipart.ts
estimated_iterations: 2
---

# WI-1: Add `splitOnBoundary` for multipart body parsing

The runner aggregates webhook payloads from GitHub. Some are sent as `multipart/related`. We need
a small helper to split such bodies on a boundary marker and return the inner parts.

## Status: complete

- New `splitOnBoundary` in `src/multipart.ts`.
- Four tests covering the four ACs (split, no-marker, closing-marker, whitespace-preservation).
