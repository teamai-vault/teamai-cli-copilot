# Team AI CLI implementation plan

The current product line is **TeamAI V4**, with CLI package version **0.5.1**. V4 names the architecture and delivery work; it is not the npm version.

## Current implementation and requirements

- [`HANDOFF.md`](HANDOFF.md) records current behavior, source entry points and verification limits.
- [V4 Spec #14](https://github.com/teamai-vault/teamai-cli-copilot/issues/14) defines the cross-repository Scope, ownership, publication and delivery contracts. Its original 0.4.0 baseline and gap inventory are historical, not a list of today's missing features.
- [Recall follow-up #29–#35](https://github.com/teamai-vault/teamai-cli-copilot/pull/41) delivered the subsequent lexical ranking, required literals, snippets and Agent work. In particular, BM25 is implemented even though the original V4 Spec excluded it from its initial scope.
- [PR #43](https://github.com/teamai-vault/teamai-cli-copilot/pull/43) contains later Agent guidance, CI scheduling and bootstrap stdin handling changes. Consult the current source and [development index](development/README.md) for their contracts and evidence.
- [`VERSIONING.md`](VERSIONING.md) defines independent CLI, Marketplace and Plugin versions and release checks. Source delivery and passing CI do not by themselves establish V4 release acceptance.

The retired Product CLI and `kind: product` remain unsupported. Logical Project binding is explicit; a manifest-selected `kind: project` package supplies native Workspace components rather than a globally installed Plugin.

## Historical design

The [V3 architecture](v3/teamai-next-architecture-final-v3.md) and [V3 implementation sequence](v3/teamai-next-implementation-plan-v3.md) preserve earlier decisions. Their project-package route, phase status and one-shot Learning flow must not override the V4 implementation. Keep historical evidence intact instead of rewriting it as current acceptance.
