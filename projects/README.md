# `projects/` — Managed Projects

> Gitignored. Each subdirectory is a managed project; forge auto-discovers them.

## Onboarding a project

1. Clone (or symlink) the project repo here:
   ```bash
   git clone <url> projects/<name>
   # OR
   ln -s ~/path/to/repo projects/<name>
   ```
2. The first cycle on this project will:
   - Create `projects/<name>/brain/profile.md` (initial taste profile, populated by Pass B or by the architect).
   - Open the project's directory tree to the architect during ideation.
3. From then on, the architect, project-manager, developer-loop, reviewer, and reflector all read this directory as the project's working tree.

## Per-project conventions

- `<project>/.forge/` — gitignored at the project level; forge writes work-item specs, demo scripts, and per-project state here.
- `<project>/.forge/work-items/` — populated by the project-manager skill.
- `<project>/.forge/demos/` — populated by the reviewer skill.

## Multi-project orchestration

Forge enqueues initiatives across all projects into a single `_queue/`. The scheduler claims them in order; the worktree per initiative keeps projects isolated. Cross-project work isn't directly supported (and shouldn't need to be); a single initiative is scoped to one project.

## Why gitignored

Forge's repo holds the *system*. The projects forge manages are independent repos with their own histories. Symlinking or cloning them into `projects/` makes them visible to forge without committing them into forge's git history.
