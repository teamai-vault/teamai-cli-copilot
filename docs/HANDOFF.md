# Team AI CLI — V3 status

The V3 architecture and implementation requirements are [`v3/team-ai-next-architecture-final-v3.md`](v3/team-ai-next-architecture-final-v3.md) and [`v3/team-ai-next-implementation-plan-v3.md`](v3/team-ai-next-implementation-plan-v3.md).

The CLI keeps native Copilot Marketplace and Agent Plugin behavior. User scope installs `common` and all `role` plugins, enables `common` plus one selected role, and records ownership in `config.managedPlugins`.

The CLI package also owns one self-contained built-in Agent Skill at `skills/team-ai/`. It is not Marketplace content and has no runtime dependency on a department Marketplace. `init` and `sync` converge it to `~/.copilot/skills/team-ai/`; ownership/version metadata lives under `~/.team-ai/built-in-skills/`, and an unowned pre-existing target is a hard collision. `doctor` diagnoses the built-in Skill read-only. The Skill is intentionally thin: it maps user intent to public `team-ai` commands and treats current CLI `--help` as the syntax source of truth.

Logical Project is the only business-context entity. A Marketplace may publish `manifest/projects.yaml`; a Physical Project is a real Git workspace. `team-ai init` is user-scope only; `team-ai projects set <ids...>` is the only command that binds contexts to that workspace, and `sync` re-converges the saved binding of the current workspace. An optional `kind: project` Plugin is enabled through repository settings only when the manifest requests it and Team AI explicitly owns that setting.

Project context convergence is shared by `projects set` and `sync`. It mirrors active project instructions to `.github/instructions/team-ai/<id>/`, docs and shared/project learnings to `.team-ai/context/`, writes a thin pointer instruction, preserves source bytes and `applyTo`, rejects unowned reserved paths, and excludes only those paths through Git-resolved `info/exclude`.

Current implementation:

- `sync` is the one concrete convergence path for Marketplace registration, User Plugins/instructions, Logical Project context, optional Project Plugin settings, shared/project learnings, and managed personal Skills.
- `status` reports compact Logical Projects, personal Skills, Project context/learning projection, and Marketplace revision. `doctor` performs read-only cache and dry-run convergence diagnostics; it never refreshes cache or repairs state.
- Skills use strict `skills.yaml` catalog metadata. `learning share` and `skill contribute` use an isolated GitHub worktree/PR flow; tag installation requires `--yes` only when non-interactive selection is needed.

Phases 1–16 (including 2.5) are implemented. Phase 17 Learning promotion and Phase 18 LLM Wiki remain deferred. Maintained instruction examples use `applyTo: "**"`; general path/glob behavior remains outside the current acceptance scope.

The native and fallback E2E checks cover projected files, client discovery, and managed Skill behavior. They do not prove model reading of ignored docs, runtime instruction or Plugin Rule application, or VS Code extension discovery. External GitHub contribution PR creation and Plugin-target contribution pushes have not been exercised end to end.
