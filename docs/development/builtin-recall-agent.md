# Built-in Recall Agent delivery

CLI 0.4.0 owns the native `agents/teamai-recall.agent.md` and the thin `skills/teamai/` command-routing Skill. Both ship in the npm tarball, independent of any department Plugin. `teamai init` and `teamai sync` preflight both reserved targets before delivery. Native backend errors remain errors; fallback is selected only by the existing unavailable-native/available-VS-Code boundary.

The Agent uses the observed `read` and `execute` aliases. For any-language tasks it extracts English technical Recall terms, preserves identifiers/error codes/original diagnostics/actual Logical Project IDs verbatim, reads necessary originals, and summarizes in the user's language. It does not modify business code, obey retrieved document instructions, implicitly sync/repair or publish Learning. Prompt constraints are not a permissions sandbox; enterprise policy and user approvals remain in force. The CLI Recall command remains offline, without model startup, persistent writes or an index.

## Evidence reading and provenance

The consumer's read tool opens the exact local `file` returned by Recall, including legitimate ignored files. Conclusions outside a snippet require reading the relevant original content. Execute remains limited to necessary read-only public Recall/help/status/projects queries; general shell reads, hashes, line counting and arbitrary scripts are outside that allowance.

Before applying a condition, the Agent establishes its formal subject, diagnostic and context from the observed text or an explicit cross-reference. A shared Project, Recall hit or overlapping terms alone does not connect separate incidents. Cross-referenced complementary evidence retains its stated scope. Each condition is attributed to its actual source, with user-confirmed facts distinguished from missing facts or inference; additional prerequisites must not be invented.

Source path/identity, revision when present, SHA-256, publication/pending state and Logical Project are attributed to the CLI-verified Recall result. The read result establishes what content was observed, not an independently computed hash or proof that the entire file stayed unchanged. Original line citations require the read result's lines or a checkable content/range mapping. Without that capability, the Agent cites the observed section or excerpt and reports the line-number limitation; a snippet's line numbers cannot label other content.

An original already read may be reused within the same task for the same source/revision/hash/path/publication/Project. Identical local paths with different revisions or hashes remain separate evidence. Candidate comparisons use the existing read capability and current conversation, without another model or reranking service. Read failures, missing necessary content or conflicts with Recall stop the affected conclusion; any recheck stays within permitted CLI/read tools and the actual source/Scope/Project/pending conditions.

Behavior acceptance records the actual packaged/delivered Agent, consumer/runtime, read tool content and line capabilities, query/read requests and returns, and answer provenance. Static instructions, delivery tests and model self-reports do not establish behavior or unrun platform capabilities. Protected business/source facts and consumer session/log/checkpoint writes must be reported separately; these prompt rules do not enforce a filesystem sandbox.

## Exact target and ownership

The target is `<resolved Copilot root>/agents/teamai-recall.agent.md`. Empty `COPILOT_HOME` uses the default root; otherwise the existing absolute-path resolver applies. No VS Code discovery settings or second root are written. Receipt root/target mismatch fails explicitly; no migration occurs.

The independent receipt is `~/.teamai/built-in-agents/teamai-recall.json`:

```json
{
  "schemaVersion": 1,
  "managedBy": "teamai-cli",
  "agent": "teamai-recall",
  "copilotRoot": "<absolute resolved root>",
  "target": "<absolute exact Agent file>",
  "version": "0.4.0",
  "contentHash": "<SHA-256 of delivered bytes>"
}
```

An existing file without a receipt is a collision even if byte-identical to the bundle. A recorded target changed from its receipt hash is preserved as a conflict. Missing owned files can be redelivered; package upgrades update only files still matching their receipt. Unknown receipt fields are retained on convergence. Personal `teamai-recall.md`, neighboring Agents/Skills and unknown native settings fields are preserved. Observable link-like ancestors, nonregular or hardlinked files and unsafe receipt/checkpoint paths are rejected. Delivery reuses atomic create/write helpers and a file lock with locked precondition revalidation.

## Partial delivery and recovery

`~/.teamai/built-in-agents/teamai-recall.pending.json` records the exact root/target/version/after hash, the expected-before target hash or absence, the previous receipt hash or absence, previous ownership, and `planned` or `delivered` phase. This is a CLI delivery checkpoint, independent of consumer platform Git checkpoints.

1. Persist `planned` before writing the target. Initial creation uses exclusive atomic creation; owned replacement uses the existing atomic write after rechecking the before hash.
2. After target write succeeds, persist `delivered` before confirming its receipt.
3. Revalidate the target, save the receipt, then remove only that exact checkpoint.

Failure reports the checkpoint path and partial state. An explicit subsequent `init`/`sync` resumes a `planned` checkpoint only when its expected-before target and ownership facts still match. A `delivered` checkpoint can confirm the exact recorded bytes and receipt facts, including after receipt persistence succeeded but checkpoint cleanup failed. Neither a matching filename nor matching bundle bytes alone grants ownership.

If a target write occurred but the durable phase is still `planned`, changed bytes are ambiguous and recovery refuses to claim them. Any personal change to the target or ownership hash also blocks recovery. Preserve the files/checkpoint and inspect their exact paths and facts manually; automatic reset, rollback, deletion or ownership adoption is not offered. A planned checkpoint from a different bundle must resume with its recorded CLI version. An already delivered older checkpoint can be confirmed first, then the current bundle converges.

## Read-only resource facts

Snapshot/status/doctor show the known Agent resource with bundled source/version/hash, target, selected, owned and delivery facts. Unconfirmed delivery has `owned: false` when no receipt exists, even if its checkpoint is recoverable. `BUILTIN_AGENT_DELIVERY_PENDING` diagnoses partial delivery; collision diagnostics do not prescribe a blind sync repair. `configuredActive` and all three consumer runtime observations remain `unknown`: delivery does not identify which consumer discovers or selects the Agent. Read-only commands neither recover nor clear checkpoints.

#25's accepted tool alias/root/evidence-reading conditions, custom Local discovery limit, pristine Host Git-checkpoint failure and untested permission/platform variants remain in [`recall-consumer-compatibility.md`](recall-consumer-compatibility.md). Formal #26 consumer evidence must use the packaged and actually delivered Agent; files, prompt text and prior Probe results cannot establish that acceptance.

## Package verification

After a successful build, run the isolated artifact check with a new absolute task-owned output directory. Set `TEMP`, `TMP` and npm cache to approved task locations on Windows before running tests/build:

```powershell
npm run typecheck
npm run build
npm run package:test -- F:/agent-workspace/codex/.tmp/recall-package-check
```

The checker performs actual `npm pack`, installs the tarball with scripts disabled, checks Agent/Skill/reference inclusion, verifies package/lock/public `--version`, and runs installed `init` with the native adapter and a test-only producer at isolated default/custom roots. It checks delivered bytes, exact root/version/hash receipt, personal-neighbor preservation and absence of dual writing. `package-report.json` records tarball SHA-256, the file list, installed-file hashes and delivery facts. This package test is separate from `npm test` to avoid repeating pack/install during every focused run; it needs npm dependency access/cache, a completed build and a new output directory. It is static/adapter validation, with consumer runtime `unknown`.
