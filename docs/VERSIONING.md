# Team AI Versioning

Team AI uses Semantic Versioning independently for the CLI, the Marketplace catalog, and each Plugin.

## CLI

The CLI version must match in `package.json`, `package-lock.json`, and `teamai --version`.

TeamAI V4 is the product/design line; the current CLI package is `0.5.1`. Marketplace and Plugin versions remain independent. Documentation-only clarifications do not require a CLI version bump; a change to the shipped Agent/Skill behavior must be evaluated as a package change.

- Major: breaking command, config, or managed-state contract.
- Minor: backward-compatible command or capability.
- Patch: backward-compatible fix or internal hardening.

The bundled `skills/teamai/` Agent Skill has no independent release version. It is part of the CLI package and uses the CLI package version in its ownership record. After a CLI upgrade, the next `teamai init` or `teamai sync` converges the installed built-in Skill to the bundled content.

The native bundled Recall Agent follows the same CLI version. Its independent receipt records the resolved Copilot root, exact Agent file target and content SHA-256. `package:test` checks the actual npm tarball, installs it in an isolated directory, validates references and the public version, and exercises bundled delivery to default/custom roots; it does not claim consumer runtime.

## Marketplace

The Marketplace metadata version describes the catalog as a whole.

- Major: breaking catalog identity or distribution contract.
- Minor: Plugin added or a backward-compatible catalog capability introduced.
- Patch: catalog metadata or validation fix that does not change available capabilities.

The private npm package version follows the same Marketplace metadata version so repository tooling reports one release identity.

## Plugins

Each Plugin has an independent version. Its `plugin.json` version must exactly match its Marketplace catalog entry.

- Major: breaking capability behavior or required configuration.
- Minor: backward-compatible capability added.
- Patch: compatible fix or documentation-only clarification that changes shipped Plugin content.

Unchanged Plugins keep their versions when another Plugin or the Marketplace catalog changes.

## Release gate

Before publishing, run the full checks in both changed repositories. Run the real Copilot contract smoke whenever the Marketplace manifest, Plugin packaging, or Copilot adapter changes. Record any unsupported or unexecuted platform check instead of inferring success.

Update both READMEs, the version label and examples in `docs/index.html`, and `docs/HANDOFF.md` with the affected version/behavior. Validate the built public help, documentation links and Pages presentation. Preserve versioned evidence at its original identity; a version label change is not a new runtime observation.

GitHub Pages uses `main:/docs`. Documentation prepared on `teamai-v4` is published by the normal Pages build after its merge into `main`; no separate post-merge documentation edit is required. Confirm the deployed result when performing that merge/release. V4's remaining real-consumer and reviewed-contribution gates are tracked from [Spec #14](https://github.com/teamai-vault/teamai-cli-copilot/issues/14); a successful Pages deployment is independent of product release acceptance.
