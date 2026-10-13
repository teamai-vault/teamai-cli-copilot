# Development Notes

Start with [V4 implementation status](../HANDOFF.md) for current behavior and source entry points. [IMPLEMENTATION-PLAN](../IMPLEMENTATION-PLAN.md) links the cross-repository V4 Spec and subsequent Recall changes; [VERSIONING](../VERSIONING.md) defines independent versions and release gates. The product line is V4; the CLI package is 0.5.1.

## Maintained contracts and tools

- [Managed user instructions](managed-user-instructions.md): source/target ownership, byte-preserving convergence and filesystem boundaries.
- [Bundled Recall Agent](builtin-recall-agent.md): current research guidance, exact delivery receipts, recovery and package verification.
- [Platform portability](platform-portability.md): line endings, package bytes and Windows path limits; its dated acceptance note is historical.
- [V4 joint verification](v4-integration.md): public CLI delivery, Scope, published authority and retry verification, plus explicit consumer/remote-PR limits.
- [Maintainer scripts](../../scripts/README.md): Marketplace rename, explicit Learnings-branch initialization and native/fallback smoke commands.

## Versioned evidence

These reports preserve their own source revision, artifact hash, consumer and observations. They are not rolling declarations that the current package passed every case.

- [Recall Agent 0.5.1](recall-agent-prompt-0.5.1.md): finite native sessions and revised citation requirements; later prompt wording is not a new runtime observation.
- [Recall validation 0.5.0](recall-validation.md): package identity, deterministic checks and model-quality boundaries.
- [Compiled CLI observations](recall-cli-validation/README.md): help, required literals, BM25 and original snippets.
- [Recall Agent observations](recall-agent-validation/README.md): original tasks, diagnostics, citations and route limitations.
- [Recall quality](recall-quality/README.md): fixed 0.4.0 baseline, comparisons and retained failures.
- [Consumer compatibility investigation](recall-consumer-compatibility.md): historical tool aliases, default/custom-root conditions and unsupported/unverified variants.

V3 design and phase plans are historical and are linked from [IMPLEMENTATION-PLAN](../IMPLEMENTATION-PLAN.md). Keep current guidance separate from frozen reports; preserve failures and unrun variants at their recorded identities.
