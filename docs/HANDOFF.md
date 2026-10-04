# Team AI CLI — V3 status

The V3 architecture and implementation requirements are [`v3/teamai-next-architecture-final-v3.md`](v3/teamai-next-architecture-final-v3.md) and [`v3/teamai-next-implementation-plan-v3.md`](v3/teamai-next-implementation-plan-v3.md).

The CLI keeps native Copilot Marketplace and Agent Plugin behavior. User scope installs `common` and all `role` plugins, enables `common` plus one selected role, and records ownership in `config.managedPlugins`.

The CLI package also owns one self-contained built-in Agent Skill at `skills/teamai/`. It is not Marketplace content and has no runtime dependency on a department Marketplace. `init` and `sync` converge it to `~/.copilot/skills/teamai/`; ownership/version metadata lives under `~/.teamai/built-in-skills/`, and an unowned pre-existing target is a hard collision. `doctor` diagnoses the built-in Skill read-only. The Skill is intentionally thin: it maps user intent to public `teamai` commands and treats current CLI `--help` as the syntax source of truth.

Logical Project is the only business-context entity. A Marketplace may publish `manifest/projects.yaml`; a Physical Project is a real Git workspace. `teamai init` is user-scope only; `teamai projects set <ids...>` is the only command that binds contexts to that workspace, and `sync` re-converges the saved binding of the current workspace. An optional `kind: project` Plugin is a Marketplace source only when selected by the manifest; its declared native components are projected to owned Workspace locations without installing the package or changing user-level Plugin state. Hook and MCP runtime loading remains unknown until checked in an actual consumer.

Project context convergence is shared by `projects set` and `sync`. It mirrors active project instructions to `.github/instructions/teamai/<id>/`, docs and shared/project learnings to `.teamai/context/`, writes a thin pointer instruction, preserves source bytes and `applyTo`, rejects unowned reserved paths, and excludes only those paths through Git-resolved `info/exclude`.

Current implementation:

CLI 0.4.0 also bundles the native `agents/teamai-recall.agent.md`. `init`/`sync` deliver it to the single resolved Copilot root with an independent exact root/target/version/hash receipt and a minimal planned/delivered checkpoint. Unowned collisions, ambiguous interrupted writes and personal modifications are preserved. Snapshot/status/doctor expose Agent delivery, ownership and partial facts with configured activation and consumer runtime unknown. The Agent uses English technical recall terms, reads original evidence, preserves exact diagnostics/IDs/provenance and summarizes in the user's language. It performs no code edits, document-instruction execution, implicit sync/repair or Learning publication. See [`development/builtin-recall-agent.md`](development/builtin-recall-agent.md) for recovery and package verification. Package/static tests do not constitute formal consumer or release acceptance; #25's conditions and failures remain in its original compatibility report.

- `sync` is the one concrete convergence path for Marketplace registration, User Plugins/instructions, Logical Project context and declared Project Plugin components, shared/project learnings, and managed personal Skills.
- `status` reports compact Logical Projects, Project component receipts, personal Skills, Project context/learning projection, and Marketplace revision. `doctor` performs read-only cache and dry-run convergence diagnostics; it never refreshes cache or repairs state. Hook/MCP consumer runtime is unknown unless the relevant consumer was exercised.
- Skills use strict `skills.yaml` catalog metadata. `learning share` and `skill contribute` use an isolated GitHub worktree/PR flow; tag installation requires `--yes` only when non-interactive selection is needed.

Phases 1–16 (including 2.5) are implemented. Phase 17 Learning promotion and Phase 18 LLM Wiki remain deferred. Maintained instruction examples use `applyTo: "**"`; general path/glob behavior remains outside the current acceptance scope.

The native and fallback E2E checks cover projected files, client discovery, and managed Skill behavior. They do not prove model reading of ignored docs, runtime instruction or Plugin Rule application, or VS Code extension discovery. External GitHub contribution PR creation and Plugin-target contribution pushes have not been exercised end to end.
