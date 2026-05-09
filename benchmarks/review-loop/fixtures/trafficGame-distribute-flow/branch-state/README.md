# trafficGame

Browser/canvas traffic simulation game. Per-lane flow distribution is now exposed via
`distributeFlow(total, lanes)` in `src/flow.ts`.

## Quality gate

```
node --test --experimental-strip-types tests/distribute-flow.test.ts
```

## Recent work

- WI-1 (complete): added `distributeFlow` for lane-level vehicle distribution. See `.forge/work-items/WI-1.md`.
