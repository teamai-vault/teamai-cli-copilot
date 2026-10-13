# Team AI CLI

Edit `src/`; `src/cli.ts` is the executable entry point and `dist/` is generated output.

## Architecture boundaries

- Keep command parsing and exit behavior in `src/cli.ts`, command orchestration in `src/commands/`, Copilot and Marketplace formats in `src/copilot/`, and Git/project identity plus machine state in `src/project/`.
- Route native Copilot mutations through `CopilotOperations`. Native Copilot is preferred; `FallbackCopilotClient` is selected only when Copilot CLI is unavailable and VS Code is available.
- Read plugin kind from `extensions.com.company.teamai.kind`. User scope installs `common` and every `role`, enables `common` plus exactly one role. A manifest-selected `project` package supplies components projected to native Workspace paths; it is never installed or enabled as a user Plugin.
- Treat `config.managedPlugins` as the ownership boundary. Preserve matching user-owned plugins and unknown fields in Copilot, VS Code, and repository settings.
- Marketplace user instructions have one frozen contract: mirror `instructions/**/*.instructions.md` byte-for-byte into `~/.copilot/instructions/teamai/`. Team AI owns only that target subtree; preserve every other user instruction path and the existing link/path safety checks.
- Use the atomic-write helpers in `src/utils/fs.ts`; use the existing file lock for shared Copilot state.
- Keep `init` user-only. `projects set` alone changes the current Workspace binding; an empty list unbinds. `sync` resumes/converges that Workspace's saved projection, preserving sibling worktrees.
- Read published Learnings only from `teamai-learnings`. Preserve outbox payload bytes and operation IDs through retry; `pr-open` is not `published`. Recall reads verified local sources without fetching, repairing or invoking a model.

## Where to start

- Command behavior: `src/cli.ts` -> `src/commands/<command>.ts` -> the relevant `src/copilot/` or `src/project/` module.
- Marketplace discovery and plugin metadata: `src/copilot/catalog.ts`. When changing the managed instruction contract or implementation, read `docs/development/managed-user-instructions.md` before `src/copilot/user-instructions.ts`.
- Native/fallback behavior: `src/copilot/cli.ts`, `src/copilot/fallback.ts`, and `src/copilot/user-state.ts`.
- Config or worktree-aware state: `src/config/`, `src/project/anchors.ts`, and `src/project/state.ts`.
- Learning publication and retry: `src/commands/learning.ts`, `src/contribution/`, and `src/project/published-cache.ts`. Recall: `src/commands/recall.ts` and `src/project/recall.ts`.
- Bundled Agent/Skill delivery and recovery: `src/copilot/builtin-agent.ts`, `src/copilot/builtin-skill.ts`, and `docs/development/builtin-recall-agent.md`. Prompt behavior and finite consumer evidence are indexed in `docs/development/README.md`.
- Marketplace rename utility: read `scripts/README.md` before changing or running `scripts/rename-marketplace.mjs`; start with its dry run because it edits a sibling Marketplace repository.
- When changing a persisted contract, ownership rule, backend boundary, or release behavior, read `docs/IMPLEMENTATION-PLAN.md`, `docs/HANDOFF.md`, and `docs/VERSIONING.md` first.

## Documentation

- Keep `README.md`, `README.zh-CN.md`, `docs/index.html` and `docs/HANDOFF.md` aligned with affected public behavior. Use `src/cli.ts` and built `--help` for command syntax, `package.json` for the CLI version, and the implementation for ownership/Scope/recovery claims.
- `docs/IMPLEMENTATION-PLAN.md` points to the V4 Spec and subsequent Recall changes. `docs/v3/` and versioned validation reports are historical evidence, not the current implementation contract. Preserve their recorded revisions, hashes, failures and unrun variants.
- Distinguish delivery, configured activation and observed consumer behavior. Keep example output visibly illustrative; do not turn fixtures or CI into native-consumer acceptance.
- Pages is the static `docs/index.html` served from `main:/docs`. Prepare documentation on the feature branch; a normal merge carries it to Pages. Check page navigation, command copying, narrow-screen layout and relative links when editing it. Deployment settings are a separate action.

## Verification

For documentation-only changes, verify claims against source and public help, check links and text encoding, and exercise affected page navigation, copying and layout. Do not run typecheck, build, full Vitest or product E2E suites solely for prose or static-page edits. Changes to bundled Agent/Skill instructions can affect product behavior and need the relevant package and behavior checks.

Run commands from the repository root. Prefer the smallest matching Vitest file while iterating:

```bash
npm run test:unit
npx vitest run test/integration/cli.test.ts
```

The CI gate is sequential:

```bash
npm run typecheck
npm run test:ci
npm run build
```

CI uses at most two isolated fork workers; tests within each file remain sequential. Local `npm test`, `test:unit`, and `test:integration` retain serial file execution for debugging under load. Keep the worker bound and isolation when changing CI scheduling: tests mutate process environment and start many Git/Node subprocesses.

Run the real product checks after building when Marketplace packaging, plugin convergence, or either Copilot backend changes:

```bash
npm run test:e2e:copilot
npm run test:e2e:fallback
```

Both E2E scripts require the sibling `../teamai-marketplace`, Git, and a real `copilot` executable; they use isolated temporary profiles. Record the platform actually exercised instead of inferring cross-platform success. Run test gates sequentially because integration tests start many subprocesses and fixed per-test timeouts can fail under concurrent load.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `teamai-vault/teamai-cli-copilot`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout. See `docs/agents/domain.md`.
