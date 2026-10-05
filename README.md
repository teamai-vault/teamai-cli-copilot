# Team AI CLI

[中文](README.zh-CN.md) | English

`teamai` is a thin, Copilot-native control layer for shared GitHub Copilot capabilities. It keeps Agent Plugin packages, the department Marketplace, and project-local `.github/*` customization in their native locations instead of introducing another runtime or plugin format.

The CLI is independent from any particular department Marketplace. Each user configures one Marketplace source; departments can maintain their own Marketplace while using the same CLI.

## Architecture

```text
                    teamai CLI
              company-wide control plane
                         |
                         | init --marketplace <source>
                         v
              Department Marketplace
              .github/plugin/marketplace.json
                         |
                         | manifest.name + plugin metadata
                         v
              common@<marketplace>
              api@<marketplace>
              ios@<marketplace>
              aos@<marketplace>
              qa@<marketplace>
              design@<marketplace>

real business repository
  .github/copilot/settings.json
  .github/copilot-instructions.md
  .github/skills/
  .github/agents/
  .github/instructions/
  .github/hooks/
```

The CLI has no built-in department Marketplace. `teamai-vault/teamai-marketplace` is the reference/template Marketplace used by this workspace, not a CLI dependency.

## Built-in Agent Skill

The npm package ships a small, self-contained `teamai` Agent Skill from `skills/teamai/`. `teamai init` and `teamai sync` converge that bundled Skill to:

```text
~/.copilot/skills/teamai/
```

The Skill teaches an Agent how to route Team AI intent through the public CLI and to use current `--help` output for exact syntax. It does not read or depend on a department Marketplace's files or layout. Its shipped version follows the CLI package version.

Ownership is recorded separately under `~/.teamai/built-in-skills/`. An existing `~/.copilot/skills/teamai/` without Team AI CLI ownership is treated as a collision and is never silently overwritten. `doctor` reports missing, stale, or colliding built-in Skill state.

The package also ships the native `teamai-recall` Agent (`agents/teamai-recall.agent.md`). `init` and `sync` deliver it to the resolved Copilot root's `agents/teamai-recall.agent.md`, with an exact root/target/version/SHA-256 receipt under `~/.teamai/built-in-agents/`. An existing target without a receipt is a collision even when its bytes match the bundle; neighboring personal files are preserved. Interrupted delivery records a minimal checkpoint. Explicit `init`/`sync` can confirm a delivered checkpoint after revalidation; ambiguous delivery or personal changes require manual inspection and remain untouched. See [the delivery and recovery contract](docs/development/builtin-recall-agent.md).

Recall Agent turns any-language tasks into English technical search terms, preserves exact identifiers, diagnostics and actual Project IDs, reads necessary originals, and summarizes with provenance in the user's language. It does not edit code, follow document instructions, implicitly sync/repair, or publish a Learning. Its tools obey user permissions and enterprise policy. `status --resources`/`--json` and `doctor` report delivery separately from configured activation and consumer runtime; runtime remains unknown until independently observed. Custom-root CLI delivery does not establish VS Code discovery.

## Requirements

- Node.js 20+
- Git
- Optional backend: GitHub Copilot CLI available as `copilot` (native backend), or VS Code available as `code` (fallback backend). Marketplace-managed user instructions are file-based and can converge without either backend; plugin convergence still requires one.

## Development installation

```text
npm install
npm run build
npm link
```

## Marketplace and plugin contract

`--marketplace` accepts a native Copilot source: a GitHub `owner/repo` reference, a ref-qualified reference, an HTTP(S)/SSH/git URL, or a local path. Relative local paths are normalized to absolute paths before they are persisted. The manifest name is discovered from the registered Marketplace; users do not provide it separately.

Plugin names are the names published by the Marketplace:

```text
common
api
ios
aos
qa
design
```

The plugin name does not encode its kind. The CLI reads the shared metadata namespace `com.company.teamai`:

```json
{
  "name": "api",
  "extensions": {
    "com.company.teamai": {
      "kind": "role"
    }
  }
}
```

`kind` is `common`, `role`, or `project`. A Logical Project may optionally reference one `project` Plugin from `manifest/projects.yaml`.

## Logical Project context and learnings

`teamai init` configures only user scope and never binds Logical Projects. `teamai projects list` reads the catalog; `teamai projects set <ids...>` (repeated or comma-separated IDs) is the only command that changes the current physical Git workspace binding, and `sync` re-converges the saved binding of the current workspace only. Convergence covers user-level Marketplace Plugins and instructions, plus bound-workspace Logical Project context and manifest-selected Project Plugin components.

Active Project instruction files are mirrored byte-for-byte to `.github/instructions/teamai/<id>/`; project docs and project/shared learnings go to `.teamai/context/`. Team AI writes one `context.instructions.md` pointer with `applyTo: "**"`, plus Git-resolved `info/exclude` entries for only those two reserved roots. It never adopts an occupied reserved path, even if empty, and never rewrites Marketplace source frontmatter. Portable or path-specific `applyTo` matching remains a documented future validation item; no runtime instruction injection is claimed.

## Marketplace-managed user instructions

An optional Marketplace `instructions/` directory may contain native Copilot instruction files at any depth:

```text
instructions/**/*.instructions.md
```

`teamai init` and `teamai sync` mirror those files byte-for-byte into the managed user-level directory `~/.copilot/instructions/teamai/`, preserving relative paths. The directory is Team AI-owned; keep personal instructions elsewhere under `~/.copilot/instructions/`. File and folder names only organize content—Team AI does not assign company, department, role, or action semantics, and native Copilot frontmatter remains unchanged.

This is the only narrow exception to the prohibition on arbitrary or generic resource copying/injection: the concrete use case is deploying department-approved Copilot user instructions. Marketplace maintainers own and review the content; Team AI owns only `~/.copilot/instructions/teamai/` and mirrors the frozen `instructions/**/*.instructions.md` contract there. The CLI accepts regular single-link-count files and rejects link-like entries or unsafe source/target boundaries visible during its filesystem checks, writes atomically, and leaves all other user instructions untouched. It does not defend against a separate process replacing an already-checked path during the operation; that race is outside the V1 threat model.

If both Copilot CLI and VS Code are unavailable, `init`/`sync` still converge this file tree but return an error explaining that plugin convergence could not run; the command must not report full initialization or synchronization success.

## First-time initialization

The four first-time interactive combinations are:

```text
teamai init                                             # prompt for Marketplace, then Role
teamai init --marketplace <source>                      # prompt for Role
teamai init --role api                                  # prompt for Marketplace
teamai init --marketplace <source> --role api           # no prompts
```

In an interactive terminal, the role picker uses the roles exposed by the Marketplace and selects exactly one role. In a non-TTY environment (CI, redirected stdin, or another non-interactive shell), missing values are errors rather than prompts. Supply both values explicitly:

```text
teamai init --marketplace <source> --role <role>
```

Initialization:

1. checks GitHub Copilot CLI and chooses the native backend when it is available;
2. loads the Marketplace and discovers its manifest name;
3. registers the source through native Copilot operations when needed;
4. installs `common` and every `kind: role` plugin in the catalog;
5. enables only `common` and the selected role;
6. stores the selected role, Marketplace identity, and explicit Team AI ownership;
7. writes user-scope state only; bind Logical Projects separately with `teamai projects set`.

An optional `kind: project` Plugin is only a Marketplace source for components selected by `manifest/projects.yaml`. Binding a Logical Project projects its declared Agents to `.github/agents/`, Rules to `.github/instructions/teamai/<id>/`, Skills to `.github/skills/`, Hook declarations and referenced files to `.github/hooks/`, and MCP server entries plus referenced local files to `.mcp.json` and `.teamai/project-components/`. The CLI records exact file/config ownership, rejects unowned target collisions, and removes only those owned entries on unbind. It never installs or enables the Project Plugin in user-level Copilot state. A same-name user Plugin is preserved; consumer isolation and runtime loading remain unobserved until tested in that consumer.

Example persisted config:

```yaml
version: 1
marketplace:
  name: payments-ai
  source: https://github.com/example-org/payments-ai-marketplace.git
role: api
managedPlugins:
  - common@payments-ai
  - api@payments-ai
  - ios@payments-ai
  - aos@payments-ai
  - qa@payments-ai
  - design@payments-ai
```

The config schema is version `1` and uses `marketplace.source` as its only source field. After initialization, normal commands use the saved Marketplace and refuse a different source instead of silently rebinding.

## Commands

```text
teamai init [--marketplace <source>] [--role api|ios|aos|qa|design]
teamai projects [list]
teamai projects set <ids...>
teamai learning share <file> [--project <id>|--shared] [--tags <tag...>]
teamai recall <query> [--scope auto|user|workspace] [--project <id>] [--limit <n>] [--require <literal>] [--include-pending] [--json]
teamai skill list [--tag <tag>] [--owner <owner>] [--source plugin|standalone]
teamai skill show <name>
teamai skill install <name...>
teamai skill install --tag <tag> [--yes]
teamai skill remove <name...>
teamai skill contribute <path> --owner <owner> [--tags <tag...>] --target standalone|plugin [--plugin <plugin>]
teamai tags list
teamai sync
teamai role list
teamai role set <role>
teamai status
teamai doctor
```

All write commands support the global `--dry-run` option. A first-time dry run can inspect the supplied Marketplace and reports planned Marketplace/plugin/config/project changes without mutating state.

`learning share` adds the supplied Markdown body to `learnings/<project>/<uuid>.md` through a GitHub pull request. The generated UUID is also the frontmatter `id` and saved operation ID. It defaults to the one active Logical Project, uses `shared` with none, and requires `--project` or `--shared` with several. Contributions use an isolated bare clone and worktree; they never change the active Marketplace checkout or shared read cache. A dry run previews the branch, commit, push, and pull-request steps without performing them.

`recall` searches the cached published Learnings and active Project docs locally. `auto` uses Workspace scope when the current Git workspace has active Logical Projects and User scope otherwise; User scope searches shared Learnings, while Workspace scope searches shared Learnings and active Project docs/Learnings. `--project` narrows Workspace scope to one active Project. `--include-pending` adds only incomplete local drafts that match the source and scope. Learning JSON IDs use `learning:<logicalProject>:<uuid>` for both published and pending results (`shared` for shared Learnings); `publication` identifies their state. Recall makes no network or model calls and writes no state. Use whitespace-separated Chinese terms, for example `teamai recall 支付 重试`; JSON results include the local file, source revision/hash, matching terms, original line numbers, and evidence snippet.

`teamai recall --help` succeeds without a query, binding, knowledge cache or native runtime and prints human-readable stdout even with `--json`. Recall uses NFC/case-normalized substring matching: whitespace separates query terms and at least one must match; shell quotes only pass arguments and do not enable phrase matching. Without required literals, queries allow at most 1024 Unicode code points and 32 whitespace-separated terms before deduplication; `--limit` is 1-20, default 5. Results use descending in-memory substring BM25 score, then stable ID. Non-overlapping title/individual-tag/body frequencies use weights 3/2/1, with saturation and whitespace-word length normalization (k1=1.2, b=0.75). Corpus statistics use the full verified allowed set before query, required-literal and limit filtering; required conditions stay hard. Rank and matched-term count are not evidence of answer correctness or semantic confidence; the Recall Agent reads original evidence and filters/reranks for relevance separately. The CLI does not translate or provide semantic search. English-first is the knowledge contribution convention, while ordinary Chinese queries remain supported. Try `teamai recall "Plugin discovery" --scope user` or `teamai recall "支付 重试" --limit 5`.

For a required literal condition, use `teamai recall "Plugin not" --require "Plugin not found: E_PLUGIN_42." --scope user`. Repeat `--require <literal>` for AND conditions. Each complete NFC/case-normalized literal must occur in one title, one individual tag or body, without word splitting, cross-field/tag joins or regex expansion; the query still needs an ordinary term match. Query plus all raw required values totals at most 1024 Unicode code points, and query whitespace terms before deduplication plus required value count totals at most 32 items. Empty, whitespace-only, missing and over-limit values are input errors; use `--require=<literal>` for a leading `-`. Applied original values appear in text and, only when used, JSON `requiredLiterals`; `matchedTerms` remains the query matches. Required cannot expand the verified source/scope/pending set or hide cache errors. Provenance, raw hashes and evidence stay unchanged. Literal filtering does not imply diagnostic, negation or causal understanding.

### `teamai sync`

`sync` means convergence and repair. It installs missing Team AI-owned user plugins, restores enablement, refreshes Marketplace registration, updates VS Code Marketplace registration, refreshes project machine state, and repairs managed personal Skills. For a bound workspace, it projects only the compatible components declared by its selected Logical Projects; common and role content remains in native user Plugins.

### `teamai skill` and `teamai tags`

Skill reads use the saved Marketplace cache. The catalog scans Plugin-contained and top-level Skills, then reads owner/tags/standalone governance from `skills.yaml`. `skill install --tag` resolves the current matching names and stores those explicit names; tags are not subscriptions. Top-level Skills are copied byte-for-byte to `~/.copilot/skills/<name>/`. Explicitly standalone Plugin Skills are copied there only when the containing Plugin is not already enabled. Existing unowned personal Skill directories are refused; `skill remove` deletes only recorded Team AI-owned copies.

`skill contribute` sends a local Skill directory through the same isolated GitHub worktree and PR flow as `learning share`. It requires an owner and target; plugin targets also require an existing Marketplace plugin. The command checks `SKILL.md`, unsafe paths, name collisions, and `skills.yaml` metadata, but does not provide a Skill quality-lint command.

### `teamai role`

```text
teamai role list
teamai role set qa
```

Changing role keeps all Team AI role plugins installed, enables `common` plus the new role, and disables the other Team AI-owned roles. A pre-existing user-owned plugin is preserved and is never claimed from its name alone.

### `teamai status` and `teamai doctor`

`status` reports Marketplace revision, selected Logical Projects, projected Project Plugin components, managed personal Skills, Project context, and learning projection. `doctor` reuses dry-run convergence against the locally loaded cache to report stale context, missing or colliding owned components, invalid active Project bindings, and user-level same-name Plugin overrides without repairing them. Neither command refreshes a remote Marketplace cache. Hook and MCP declarations are summarized with runtime unknown until an actual consumer loads them; the CLI does not execute either component.

## Native Copilot and VS Code-only fallback

When `copilot` is available, Team AI uses the native command family:

```text
copilot plugins marketplace add ...
copilot plugins marketplace list --json
copilot plugins marketplace browse <name> --json
copilot plugins install ...
copilot plugins enable ...
copilot plugins disable ...
copilot plugins update ...
```

When Copilot CLI is unavailable but `code` is available, Team AI uses a VS Code-compatible fallback. It reads the same Marketplace/plugin contract, materializes managed plugins into the Copilot-compatible location, and merges Copilot metadata:

```text
~/.copilot/installed-plugins/<marketplace>/<plugin>
~/.copilot/config.json
~/.copilot/settings.json
```

The fallback writes `installedPlugins` inventory and `enabledPlugins` state, while keeping `settings.json.enabledPlugins` as effective enablement authority and mirroring the inventory flag. Unknown fields and existing `source_sha` values are preserved; fallback-created rows do not calculate a synthetic `source_sha`.

## Copilot and VS Code Marketplace registration

User-level Copilot registration is represented by `extraKnownMarketplaces` in `~/.copilot/settings.json`. The real Copilot backend lets native Copilot own that update; the fallback merges only the configured Marketplace entry and preserves unknown/native fields.

Team AI also registers the source in VS Code User Settings under `chat.plugins.marketplaces`. The merge is JSONC-safe: comments, trailing commas, unknown settings, and existing entries are preserved, while the configured source is inserted or moved to index `0`.

Logical Project projections use `.github/instructions/teamai/**` and `.teamai/context/**`; both reserved paths are rejected when unowned. Manifest-selected Project Plugin components are written to their native Workspace locations using exact ownership receipts. The optional `kind: project` package is never added to user-level installed Plugins or workspace `enabledPlugins`.

## Ownership and project state

`managedPlugins` is the ownership boundary. Team AI may install, enable, disable, update, or repair only plugins it explicitly installed or claimed during convergence. User-owned and third-party plugin state remains untouched.

The real business Git repository is the Project scope. Project-specific Copilot customization stays in `.github/*`; Project is not a Plugin type. Machine state is partitioned by the stable Git project anchor:

```text
~/.teamai/
  config.yaml
  projects/
    <safe-anchor>-<hash>/
      anchor
      state.json
```

## Marketplace rename utility

The checked-in `scripts/rename-marketplace.mjs` is a Marketplace maintainer utility. It changes the logical Marketplace ID inside the target Marketplace repository and does not modify the generic CLI or user-owned machine/project state.

```text
npm run rename:marketplace -- --from teamai --to payments-platform-ai --dry-run
npm run rename:marketplace -- --from teamai --to payments-platform-ai --display-name "Payments Platform AI"
```

See [`scripts/README.md`](scripts/README.md).

## Validation and tests

```text
npm run build
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e:copilot
npm run test:e2e:fallback
npm test
```

The two E2E scripts create isolated temporary profiles and repositories. `test:e2e:copilot` verifies projected instruction bytes and native instruction listing by name/scope/source, plus exact native paths for a real personal Skill and an enabled Plugin Skill. `test:e2e:fallback` requires `TEAM_AI_E2E_CODE_BIN` or a working `code` command, validates it with the isolated profile, then exercises the VS Code-only materializer and native recognition of the materialized state. Resource listing is not proof that a model read ignored docs or applied `applyTo`; that authenticated model-read probe remains unverified. Current implementation status and verification limits are summarized in [`docs/HANDOFF.md`](docs/HANDOFF.md).

## Non-goals

This project does not implement a default Marketplace, multiple-Marketplace merge/overlay/precedence, a package manager, another agent runtime, an IDE abstraction, custom Plugin/Skill/Hook/MCP formats, arbitrary or generic resource copying/injection beyond user instructions and manifest-selected Logical Project components, a generic overlay engine, telemetry, dashboards, or a custom business-context database.

## Project documents

- [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) — entry to the V3 design and implementation requirements.
- [`docs/HANDOFF.md`](docs/HANDOFF.md) — current V3 implementation status and verification limits.
- [`docs/VERSIONING.md`](docs/VERSIONING.md) — CLI, Marketplace, and Plugin release/version rules.
