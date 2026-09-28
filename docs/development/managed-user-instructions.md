# Managed User Instructions

## Contract and ownership

The Marketplace source and installed target are deliberately different:

```text
Marketplace: instructions/**/*.instructions.md
User target: ~/.copilot/instructions/teamai/
```

Relative paths and bytes are preserved. Marketplace maintainers own the approved source content; Team AI owns managed instruction state in the target subtree. Personal or third-party instructions must live elsewhere under `~/.copilot/instructions/`.

The source tree is desired state. `init` and `sync` create or update desired files and remove managed target files absent from the source. A missing source directory is a valid empty desired set, so convergence removes existing managed files. An existing source root that is unreadable, not a directory, or link-like is an error rather than an empty set; unsafe nested entries are excluded. Acquisition or discovery failure before planning leaves the installed target untouched. `status` and `doctor` therefore treat a missing source as empty desired state, but report an unreadable or unsafe source as unavailable or failed.

Instruction convergence is backend-independent. It runs even when neither Copilot CLI nor VS Code is available, but the command still returns an error because plugin convergence did not complete.

## Filesystem boundary

Writes are atomic per file through a sibling temporary file, flush, and rename. The whole tree is not transactional, and removals are individual unlink operations.

The current threat model checks the static filesystem it can observe: existing roots and target ancestors must be real directories; link-like entries, multiply linked source files, unsafe relative paths, and link-like target chains are rejected or excluded as appropriate. A missing target is created only after its existing ancestor chain is checked. These checks protect the declared source and Team AI-owned target from visible path escapes.

An active process can still replace a checked path between validation and use. Defending against that TOCTOU race would require stronger OS-specific handle-based traversal and is outside the current scope.

## Deliberate limits

This mechanism exists only to distribute department-approved native Copilot instruction files. It is not a generic resource copier, overlay engine, or injection framework.

Only `instructions/` is a source. Reading the former `user-instructions/` name as a compatibility layer would create two authorities plus precedence and deletion rules, so migration belongs in the Marketplace repository instead of the CLI.

## Verification boundary

Automated checks should cover discovery, byte preservation, create/update/remove planning, dry-run behavior, unsafe path handling, and the no-backend error path. Real product evidence must separately state what was exercised:

- record Windows filesystem, native, and fallback automation only when the relevant checks actually completed;
- file presence does not prove that a native client discovered or applied an instruction;
- unit coverage using non-Windows path semantics is not macOS native or fallback E2E evidence;
- record unsupported or unexecuted client and platform checks explicitly.
