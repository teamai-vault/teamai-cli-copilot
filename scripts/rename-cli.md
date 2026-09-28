# CLI rename inventory and tool

The `team-ai` to `teamai` and `teamai-cli-customization` to `teamai-cli-copilot` migration was applied on 2026-09-29. This is the pre-migration inventory and one-time tool record. The script expects the old checkout name, so its command below applies only to a pre-migration checkout.

The CLI repository name, npm package name, executable name, product identity, and extension namespace are separate inputs. `rename-cli.mjs` applies the requested values across the CLI and sibling Marketplace repositories. A value may stay the same, as with `--display "Team AI"` and `--namespace com.company.teamai` when only the command and repository are renamed. It does **not** change the Marketplace's logical ID (`teamai`), the Marketplace repository name, the GitHub owner (`teamai-vault`), the example Logical Project ID (`teamai`), or references to the original upstream TeamAI. Use `rename-marketplace.mjs` separately if the Marketplace ID itself must change.

## Rename inventory

| Identity | Current locations |
| --- | --- |
| GitHub CLI repository name | CLI `origin`, GitHub Pages project URL and repository homepage, CLI `docs/index.html`, both repositories' README and contributor links, workspace `AGENTS.md` when the local directory moves. |
| Local CLI directory | Sibling paths in Marketplace `AGENTS.md` and `docs/development/instructions-contract.md`; workspace `AGENTS.md`. Existing linked Git worktrees must be detached before moving the main checkout. |
| npm package name | CLI `package.json` and root entries in `package-lock.json`. It can differ from the GitHub repository name via `--package`. |
| Executable and public commands | CLI `package.json` bin, `src/cli.ts` help/errors, command diagnostics, bundled Skill instructions, READMEs, Pages example, Marketplace contributor commands, smoke scripts, tests, and V3 design documents. |
| Persisted product paths | `~/.team-ai/`, `~/.copilot/instructions/team-ai/`, `~/.copilot/skills/team-ai/`, `.github/instructions/team-ai/`, `.team-ai/context/`, associated locks and ownership records. These are source-code and test references; the tool does not touch any real user profile or business repository. |
| Bundled Skill and file names | CLI `skills/team-ai/`, `scripts/smoke-team-ai.mjs`, and `docs/v3/team-ai-next-*.md`; references are updated with their paths. |
| Internal identifiers and environment variables | `TeamAi`, `teamAi`, `TEAM_AI`, contribution branch prefix, and related fixture names in tracked text files. |
| Extension namespace | CLI `src/copilot/catalog.ts` and tests, Marketplace Plugin manifests, validator, tests, AGENTS, README, and Plugin Guide. |
| Product display name | Team AI prose and catalog owner/display metadata in both repositories. |

The script reads only Git-tracked text files, so ignored `devDocs/`, `dist/`, `node_modules/`, `.codegraph/`, and workspace historical source documents remain untouched. The script and its test retain the old identifiers deliberately so the tool stays reusable. Review historical documents manually if their titles or links are still presented as current guidance.

## Historical invocation

Run from the workspace parent directory. The default is a read-only preview:

```powershell
node teamai-cli-customization/scripts/rename-cli.mjs `
  --repo nova-cli `
  --package @example/nova-cli `
  --command nova `
  --display Nova `
  --namespace com.example.nova
```

Review every listed file, then add `--apply` to change the two local repositories and rename the GitHub CLI repository. The tool checks that both repositories have clean working trees, that the GitHub repository exists under the expected old name, and that the target name is unused. It updates `origin` and the repository homepage when that homepage is the old GitHub Pages project URL. It leaves the resulting changes uncommitted and unpushed for review.

Add `--rename-directory` if the local CLI checkout directory must also adopt the new repository name. This requires running outside that directory and having no linked CLI worktrees. Without this flag, the local directory and references to its sibling path keep their current spelling while GitHub links, npm identity, and product identity change.

`--skip-github` is only for rehearsing the apply path in a disposable local copy. It deliberately leaves `origin` pointing at the old repository.

After applying, run the CLI typecheck, tests, build, and both product E2E checks; run Marketplace validation, tests, and Copilot smoke. Inspect both Git diffs, then commit and push as separate reviewed actions. Check the new GitHub Pages URL after publishing because GitHub does not redirect the old project-site URL on repository rename.
