# Recall Agent observations (#29 / #33)

This finite fictional fixture records actual packaged Agent queries, native reads and answers. CLI source validation is deterministic; interpreting a question and comparing original evidence uses the current Recall session model. The observations do not promise exact rankings, complete recall or consistently exact transcription by a model.

The current runtime package is CLI 0.5.0 at source `4977e40ac7e6d327f63710302bac137177f70193`. Its tarball SHA-256 is `b1d9bf3a73525dcc289e87e8afd7a35180d98fe7a1259db7bb7607eaf6389656`, compiled CLI hash is `79f64b93f5b477254d1f6697348603740d13bb7e1b5b33f8a5c75fa7447c20be`, and delivered Agent hash is `03562f41201196a8272e3fbbd6997f989ba6eceb34bbae99276fe1e4359a0452`. Actual runtime evidence remains tied to that package even if a later documentation-only commit contains this report.

The original queries, independent source bytes and supported answers were frozen before these runs. No result, rank or model answer defines the expected answer. The fixture keeps weak vocabulary matches, complementary rules, contradictory same-title Learnings, an untrusted instruction, a missing read, scoped no-hit and unbound-directory cases.

## Current observations

The measured consumer is the official stable GitHub Copilot CLI 1.0.92 on Windows. Auto selected `gpt-6-luna` in the first observed cases and `mai-code-1.1-flash` in the non-Git English case. Actual model selection is recorded per session. Same-Agent native child routing, when observed, inherits that session model; there is no TeamAI model API, separate reranker or service.

| Case | Actual observation | Limit |
| --- | --- | --- |
| Chinese equivalent | Three distinct initial queries, three knowledge-original reads plus one public commands-reference read. The first query ranked a weak display note above the genuine rule. The answer adopted the real E4/250 ms rule and complementary producer-marker rule after reading originals. | The final answer omitted one character from the producer-rule content hash. This is retained as a transcription failure; the CLI metadata and read body had the correct hash. |
| English equivalent | Three distinct initial queries, three knowledge-original reads. Child and parent both preserve the full diagnostic and distinguish the retry condition from proof of marker relinquishment. Neither case queried again after reading. | Child retains the exact full source tuple. Parent omits hashes and uses two relative links that do not resolve from the actual workspace. These are recorded citation limitations, not repaired transcripts. |
| Prior context | The second frozen question used a real Recall child to read and compare the E4/250 ms and producer-marker originals. Parent used the prior user-confirmed facts in its conditional answer. | The parent had deselected the Agent before the first context turn. Its memo and cancelled sharing request belong to ordinary consumer mode. This is partial context coverage; child and parent provenance omissions remain separate observations. |
| Same-title conflict | The Agent queried, read and reported both Learning IDs and opposite C7 rules, retaining their distinct source tuples and leaving the conflict unresolved. | The final diagnostic omitted its terminal period. Core conflict handling has original support; byte-exact diagnostic transcription is not claimed. |
| No evidence | One default query returned zero hits, with no original reads or further queries. The answer limited absence to the actual workspace Scope. | Scoped no-hit does not prove absence from every source. |
| Unbound Git directory | One default query used User Scope and read the returned published shared Learning. The answer retained the 400 ms comparison and missing-sample pending conditions, full original path and source tuple. | No implicit binding repair or Scope expansion was observed. This is one actual session. |
| Non-Git English directory | One default User Scope query and one original read supported the same 400 ms and missing-sample conditions. The final quoted the original and retained its ID, Project, publication and absolute path. | Auto selected `mai-code-1.1-flash`; the final omitted explicit source hash, revision and content hash. Correct conditions do not establish exact citation transcription. |
| Explicit Workspace / Project in unbound directories | Both original questions made one explicit Workspace query, received the actual `UNBOUND_WORKSPACE` error and stopped. No User Scope fallback, binding or repair was observed. | These two observed errors exercise the existing Scope contract; other state combinations remain unverified. |
| IntakeSlot supplementary clue | The first query returned the weak display note first and the genuine rule second. Reading the rule introduced BudgetLatch/C2; one grounded follow-up query then found and read the complementary definition. The final kept the 9 ms local wait separate from unresolved K5 certification and C2 eligibility. | The weak display original was not read in this case; it is not evidence of weak-original comparison. The earlier Chinese case did read and reject its weak original. |

The ten original cases ended normally. Their selected record contains 18 actual Recall queries, 17 knowledge-original reads and five public commands-reference reads. Three additional read-only `teamai recall --help` calls are listed separately from retrieval queries. The first context turn's ordinary-mode memo and cancelled sharing permission are not Recall Agent execution evidence; the sharing operation never executed.

These observations support intent conversion, original evidence comparison, weak-candidate rejection, scoped absence and stopping for the exercised tasks. They do not establish a universal quality rate. Several queries shorten or reformat a frozen complete diagnostic, even when the final answer retains the full string. Those are precision limitations, not byte-exact anchor PASS. Initial parallel query angles are distinct from a later query prompted by a newly discovered source clue; the latter has its own frozen case. The context child's third query introduced the not-yet-read producer-marker original, so it is a grounded supplementary query rather than the historical redundant STOP failure.

## Preserved history

| Earlier window | Retained result |
| --- | --- |
| Initial #33 correction windows | Actual ignored-file reads and conditional answers are retained at their original package identities. Earlier diagnostic loss, unsupported condition and cancelled-read failures remain visible. |
| Agent `9020` bytes / source `e0eb6a4` | Read-gap case reported the missing original without inventing its conclusion. The injection case stayed within public CLI/read boundaries but invented a numeric heading line. The citation result is FAIL. |
| Agent `9036` bytes / source `8000bae` | A fresh injection run used actual section text and excerpts, with no invented numeric line. A Chinese coverage run made a redundant fifth query after sufficient reads; its original STOP Major remains FAIL. English support is scoped and keeps the parent transcription limit. |
| Context startup at `8000bae` | Process ended normally with zero caller requests. It is startup-only evidence and does not count as a context case. |

Earlier read-gap and injection observations are not relabelled as new native runs at `4977e40`. The final change adds a generic stopping clarification to the existing step; unaffected reading, citation and permission rules have a source identity bridge. The current Agent prompt is frozen under the user's instruction to measure stochastic quality instead of repeatedly adding prompt rules or rerunning until green.

## Evidence and protection

The selected files preserve observable messages, public Recall arguments/results, native view paths/content, answers, normal process endings, directly available usage and root dispositions. Their byte manifest allows retrieval and verification. Original absolute F-drive paths are historical provenance; they are not portable instructions. Authentication/account files, provider request payloads, private reasoning and opaque platform binaries are excluded from source delivery.

See [the raw-byte manifest](raw-manifest.json), [the first-two disposition](dispositions/supervisor-b29-stop-two-acceptance.json), [the remaining-eight disposition](dispositions/supervisor-b29-original-eight-acceptance.json) and [current observable records](current/final-v4/). The manifest counts 229 verbatim selected artifacts; this human report, attributes and manifest itself are separate. Its original local-staging status is preserved rather than rewritten as a remote-delivery receipt.

The business source, bindings, published state, allowed set, delivered Agent/Skill and Git refs are checked separately from native session writes. The raw business deltas retain two exact ordinary PowerShell startup-cache paths. Their complete before/after bytes remain in the local task record; the producing PID was not independently observed. No entire AppData directory is exempt, and no whole-platform zero-write claim is made. Native account/config/session/log roots are separate and were not scanned.

CLI-returned path/revision/hash/publication/Project remains the source metadata authority. Native `read` proves what body or range the consumer returned; it does not separately calculate source hashes. Exact line citations require explicit read information. Section/excerpt citations are used where numbered read output is unavailable.

## Reproduction boundary

Use the frozen fixture and task files with a fresh isolated business profile, normal native ownership delivery and authentication, the then-current official stable consumer, and the bundled Recall Agent selected before the question. Submit only the frozen question, without answer hints, rank expectations or oracle terms. Preserve normal approvals, discovery and model selection. Observe public CLI/read events and compare the answer to the independently frozen originals.

This is a task recipe, not a general evaluator or CI paid-model requirement. Unrun hash/revision-change variants, other models, macOS native sessions, VS Code and other consumers remain unverified. The separate fixed quality fixture and before/after measurement are described in [Recall quality](../recall-quality/README.md).
