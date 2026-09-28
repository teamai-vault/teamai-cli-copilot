# Team AI Versioning

Team AI uses Semantic Versioning independently for the CLI, the Marketplace catalog, and each Plugin.

## CLI

The CLI version must match in `package.json`, `package-lock.json`, and `teamai --version`.

- Major: breaking command, config, or managed-state contract.
- Minor: backward-compatible command or capability.
- Patch: backward-compatible fix or internal hardening.

The bundled `skills/teamai/` Agent Skill has no independent release version. It is part of the CLI package and uses the CLI package version in its ownership record. After a CLI upgrade, the next `teamai init` or `teamai sync` converges the installed built-in Skill to the bundled content.

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
