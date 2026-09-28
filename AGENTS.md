# Team AI CLI

Edit `src/`; `src/cli.ts` is the executable entry point and `dist/` is generated output.

## Architecture boundaries

- Keep command parsing and exit behavior in `src/cli.ts`, command orchestration in `src/commands/`, Copilot and Marketplace formats in `src/copilot/`, and Git/project identity plus machine state in `src/project/`.
- Route native Copilot mutations through `CopilotOperations`. Native Copilot is preferred; `FallbackCopilotClient` is selected only when Copilot CLI is unavailable and VS Code is available.
- Read plugin kind from `extensions.com.company.teamai.kind`. User scope installs `common` and every `role`, enables `common` plus exactly one role; optional `project` plugins come only from `manifest/projects.yaml` and are owned per physical workspace.
- Treat `config.managedPlugins` as the ownership boundary. Preserve matching user-owned plugins and unknown fields in Copilot, VS Code, and repository settings.
- Marketplace user instructions have one frozen contract: mirror `instructions/**/*.instructions.md` byte-for-byte into `~/.copilot/instructions/teamai/`. Team AI owns only that target subtree; preserve every other user instruction path and the existing link/path safety checks.
- Use the atomic-write helpers in `src/utils/fs.ts`; use the existing file lock for shared Copilot state.

## Where to start

- Command behavior: `src/cli.ts` -> `src/commands/<command>.ts` -> the relevant `src/copilot/` or `src/project/` module.
- Marketplace discovery and plugin metadata: `src/copilot/catalog.ts`. When changing the managed instruction contract or implementation, read `docs/development/managed-user-instructions.md` before `src/copilot/user-instructions.ts`.
- Native/fallback behavior: `src/copilot/cli.ts`, `src/copilot/fallback.ts`, and `src/copilot/user-state.ts`.
- Config or worktree-aware state: `src/config/`, `src/project/anchors.ts`, and `src/project/state.ts`.
- Marketplace rename utility: read `scripts/README.md` before changing or running `scripts/rename-marketplace.mjs`; start with its dry run because it edits a sibling Marketplace repository.
- When changing a persisted contract, ownership rule, backend boundary, or release behavior, read `docs/IMPLEMENTATION-PLAN.md`, `docs/HANDOFF.md`, and `docs/VERSIONING.md` first.

## Verification

Run commands from the repository root. Prefer the smallest matching Vitest file while iterating:

```bash
npm run test:unit
npx vitest run test/integration/cli.test.ts
```

The CI gate is sequential:

```bash
npm run typecheck
npm test
npm run build
```

Run the real product checks after building when Marketplace packaging, plugin convergence, or either Copilot backend changes:

```bash
npm run test:e2e:copilot
npm run test:e2e:fallback
```

Both E2E scripts require the sibling `../teamai-marketplace`, Git, and a real `copilot` executable; they use isolated temporary profiles. Record the platform actually exercised instead of inferring cross-platform success. Run test gates sequentially because integration tests start many subprocesses and fixed per-test timeouts can fail under concurrent load.
