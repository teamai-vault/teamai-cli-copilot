# Recall #30: fixed-corpus 0.4.0 / 0.5.0 comparison

The same frozen fixture was measured through the actual installed public CLI and normally delivered Recall Agent. The final candidate completed **34 fixed CLI queries plus three public observations, then eight native sessions / ten original question turns once**. The coordinator accepted the finite observations and closed E19. This delivers a quality comparison with retained FAIL and UNVERIFIED results; it does not certify the product or close #30.

Necessary source coverage is unchanged: both CLI versions pass all 22 positive observations at the requested limits 5 and 10. The new candidate changes 17 ordered hit lists and 102 same-ID snippet/line occurrences. Native core answers are supported in these cases, but C01 still rewrites the complete diagnostic in its query and English answer, and some final provenance fields are omitted. C01 reads more weak material than the original baseline; C02/C03 read less. No aggregate score turns these mixed observations into a universal quality or performance win.

The [original CLI baseline](baseline-0.4.0.md), [historical native setup failures](native-baseline-0.4.0.md), and [actual after-login original Agent baseline](native-baseline-after-login-0.4.0.md) remain unchanged. Their failed setup, diagnostic/citation/unsupported-claim/stop results are historical observations, not silently repaired by this later run.

## Frozen inputs and distinct revisions

| Binding | Original baseline | Actual final comparison |
| --- | --- | --- |
| Product source / version | `0fb99a7b065de71eb683d774231b518971b57e8c` / 0.4.0 | `4977e40ac7e6d327f63710302bac137177f70193` / 0.5.0 |
| Tarball SHA-256 | `dea321f1fc9fb030fc18af398bcdb796d8cec7473c085e23be97eb3ca59aded6` | `b1d9bf3a73525dcc289e87e8afd7a35180d98fe7a1259db7bb7607eaf6389656` |
| Installed compiled CLI SHA-256 | `dc1fae834fb9933c1d702d99bee3196e578f661079046dfa10a97e2acc0426a2` | `79f64b93f5b477254d1f6697348603740d13bb7e1b5b33f8a5c75fa7447c20be` |
| Bundled / actually delivered Agent SHA-256 | `7e8edba317dde8758d3f238e1845fecb6206d93c00667df4ab8cbe72e7f270e4` | `03562f41201196a8272e3fbbd6997f989ba6eceb34bbae99276fe1e4359a0452` (9279 bytes) |
| Official installed native consumer at each window | Copilot 1.0.91 | Copilot 1.0.92, normal E18 version/help preflight |
| Native C01 Auto models, Chinese / English / pronoun | gpt-6-luna / claude-haiku-4.5 / gpt-6-luna | gpt-6-luna / claude-haiku-4.5 / claude-haiku-4.5 |
| Other native sessions | gpt-6-luna | gpt-6-luna |

The final [package manifest](final-comparison-0.5.0/candidate/final-v4-manifest.json) and [actual delivery readback](final-comparison-0.5.0/native/actual-delivery-readback.json) bind the package and native targets. The final Skill and commands hashes are `15b0a7e1a44dc95942d06ec36c2a8b301d6406fe06c8b6fe422b72dfc932f295` and `e2ae88156b20cbad6baadf7b489ef5a8d1782b9f33f10bc5dc5f9cdc0a524fc4`. Full owner/version/root/unknown-field and target-byte acceptance is [separately recorded](final-comparison-0.5.0/dispositions/supervisor-c-final-v4-full-owned-delivery-acceptance.json); target hashes alone are not an ownership check. Source-tree identity is `ad24e49fe5c958a22bbaaa111c5193de56c4ab86`. The document integration base is `2a5506349ecb1a8dc35cda874c319e79788a590a`, which did not replace this runtime package.

The pre-run fixture freeze is commit `12d8c6fe7d743ba8fc4901997c2e210473ca2a70`, subtree `d185a284718659d296afa2f93cea7f225bfb41b5`, and 22-file manifest-array SHA-256 `37c2bbb2264b11755d05710ecaba1a3f94d10217cae6c6c556c18abd533fbeb7`. Six composite cases retain all 16 original bytes, concepts, literal anchors/Project IDs, evidence IDs, positions and independent support. Fifteen originals are allowed for active `atlas-payments` plus `shared`; `atlas-other` stays excluded. Five allowed documents are common-word distractors. No observed query, rank, A/B output or model answer defines these expectations.

The deterministic CLI retains its original prepared root: resource revision `d54b51b2f0432bbf1f5708509f6ae978a203be8a`, sourceHash `6ec78d01758a4fec3859f9884059d3008a46eb69623d523f7464a3d2ad5ceb82`. Native consumption retains resource revision `7dbb74107cc4c457a5043619090b11a38b74a7a0`, sourceHash `7e0deb60b0e77e11643d034e10200e61d1958eb86359e60263677cd50c7ad096`. The native-only approved owner scaffold explains this metadata difference; the original evidence bytes are the same. Both use published Learning revision `cf573d619178f5b29773ac7c616a231e789eeb75`. The revisions must not be represented as identical.

Platform fields actually recorded by the CLI are Windows `win32` / `x64`, Node `v24.15.0`. Vendor version, Auto routing, warm C01 context, actual native caller/direct routes and approval/capture waits differ between runs. This is one observed comparison, not a controlled fixed-model experiment or a causal attribution to one production change.

## Deterministic public CLI: same inputs, actual limits 5 and 10

E17 ran the unchanged recipe serially against the final installed compiled CLI; no fixture reprepare, init or rebind occurred. All 34 protocols pass: 26 exit 0 and eight genuine cache errors exit 1. Version 0.5.0, help and active Project list each exit 0. All 121 emitted hits match their frozen allowed original bytes, source/revision/relativePath/contentHash and exact snippet lines. [Actual report/streams](final-comparison-0.5.0/cli/cli-report.json) preserve complete commands, returned IDs, `matchedTerms`, snippets, line numbers, stdout/stderr and exit codes. Its original tarball UNVERIFIED field remains; [phase1's separate byte join](final-comparison-0.5.0/native/phase1-report.json) supplies the verified artifact identity.

K = prewritten English keywords; S = prewritten English sentence; Z = ordinary Chinese query. Document aliases expand to `doc:atlas-payments:contexts/atlas-payments/docs/<alias>.md`. L001/L002 are `learning:shared:30000000-0000-4000-8000-000000000001` / `...000000000002`; L003 is `learning:atlas-payments:30000000-0000-4000-8000-000000000003`. **W** means weak for the frozen question. Every following healthy style ran separately at requested limits 5 and 10. Necessary ranks and first-three order are the same at both limits; complete first-5/10 ID lists are in phase1-report.

| Case/style | Necessary ranks at 5 / 10 | Hits at 5 / 10 | First three actual candidates | Necessary coverage |
| --- | --- | --- | --- | --- |
| C01 K | retry-current 2 / 2 | 5 / 10 | retry-legacy W; retry-current; noise-agenda W | PASS / PASS; first candidate weak |
| C01 S | retry-current 1 / 1 | 5 / 10 | retry-current; retry-legacy W; drain-long W | PASS / PASS |
| C02 K | pool 1 / 1 | 1 / 1 | pool | PASS / PASS |
| C02 S | pool 1 / 1 | 5 / 10 | pool; drain-long W; drain-observation W | PASS / PASS |
| C02 Z | pool 1 / 1 | 1 / 1 | pool | PASS / PASS for this literal Chinese query |
| C03 K | observation 1; L001 2; long 3 at both limits | 3 / 3 | drain-observation; L001; drain-long | PASS / PASS for all three groups |
| C03 S | L001 1; observation 2; long 3 at both limits | 5 / 10 | L001; drain-observation; drain-long | PASS / PASS for all three groups |
| C04 K | L002 1; copy 2 at both limits | 2 / 2 | L002; backoff-copy | PASS / PASS for the alternative group |
| C04 S | L002 1; copy 2 at both limits | 5 / 10 | L002; backoff-copy; L003 W | PASS / PASS; copies are not independent |
| C05 K | injection 1 / 1 | 1 / 1 | injection | PASS / PASS for source coverage |
| C05 S | injection 2 / 2 | 5 / 10 | retry-current W; injection; L002 W | PASS / PASS; first candidate weak |
| C06 healthy K | No supporting original | 0 / 0 | none | NOT_APPLICABLE; healthy no-hit |
| C06 healthy S | No supporting original | 5 / 10 | L001 W; L002 W; injection W | NOT_APPLICABLE; relevance FAIL |
| C06 missing K/S | Error before candidates | NOT_APPLICABLE_ERROR | CACHE_UNAVAILABLE / exit 1 | NOT_APPLICABLE_ERROR |
| C06 damaged K/S | Error before candidates | NOT_APPLICABLE_ERROR | CACHE_UNAVAILABLE / exit 1 | NOT_APPLICABLE_ERROR |

Missing and damaged each ran K/S at requested 5 and 10 (four calls per profile). Error payloads have no returned limit or hit array; legacy numeric zero convenience fields in CLI observation records are not a successful empty-hit result. The raw stdout error and exit 1 remain authoritative.

Both versions have 22 positive coverage PASS and 12 not-applicable observations. Compared with 0.4.0, C02 S moves pool from rank 2 to 1 and C05 S moves injection from 4 to 2; C01 K remains legacy-first. K remains less noisy than S in some cases. C01 K and C03 K still omit the supplied NimbusQueue 2.1 qualifier: this frozen human-recipe limitation is preserved, not fixed after seeing results and not confused with Agent conversion.

The final snippets contain the fixed C03 numeric decision at long-document lines 40–42, Learning value at 6–8, and completion at 7–9; the original baseline's early snippets did not. C01 K's current-source snippet now includes its once-only supporting quote but omits the refusal at line 10. C05 K still lacks the complete blue supporting quote, while S includes it. Exact quote visibility is a narrower fact than complete answer/context support; a three-line snippet cannot substitute for reading every condition, conflict or hostile-text boundary. Full before/after line windows and quote checks are retained for each observation. These finite snippet improvements do not establish universal answer accuracy.

## Real native selection, queries, reads and candidate noise

E18 confirmed normal consumer/version/help and unchanged ownership. E19 then used the original logged F native root/workspace and eight fresh frozen session IDs. Missing/damaged controls copied only approved fictional `.teamai` business data into new F homes; the actual `COPILOT_HOME` stayed `runtime/c/native-baseline-v2/home/.copilot`. No credential, account/configuration/session identity, native ownership or login state was copied. No model, SDK/API, discovery or trust override was added.

The [current-selection readback](final-comparison-0.5.0/native/phase2-selection-readback.json) uses the last actual selected/deselected event before **each** user message: all ten are currently selected `teamai-recall` and match the frozen input. C02/C03/C04/C05/missing/damaged returned to Default after the startup selection notification; the normal menu was corrected before their first question, with current footer/selection events retained. C01 later turns have separate pre-submit observations. Launch `--agent` and an earlier banner alone are not proof of current selection.

All eight actual routes here are selected-Agent direct, with no native `task` delegation. In the original baseline C02/C03/C05 were native caller/child delegations, whose child and final caller answers remain separate. This routing difference prevents attributing reduced reads or fuller final citations solely to the new Agent instructions. C01 English and pronoun reuse its prior evidence without another query/read; they are warm conversation tests, not fresh English retrieval.

Every successful native response actually requests/returns limit 5. **Native top 10 remains UNVERIFIED_NOT_REQUESTED.** Error hit/rank/coverage fields are NOT_APPLICABLE_ERROR. The fixed CLI's limit-10 observations above are separate evidence, not an inferred native result.

| Actual native query | Exit / hits | First three actual candidates | Necessary top-5 coverage |
| --- | --- | --- | --- |
| C01 | 0 / 5 | retry-legacy W; retry-current; L001 W | PASS; current source rank 2 |
| C02 | 0 / 5 | pool; drain-observation W; drain-long W | PASS |
| C03 budget | 0 / 5 | L001; drain-observation; drain-long | PASS for all three groups |
| C03 completion | 0 / 5 | L001; drain-observation; drain-long | PASS for all three groups |
| C04 | 0 / 2 | L002; backoff-copy | PASS for the alternative group |
| C05 | 0 / 1 | injection | PASS |
| C06 healthy, both queries | 0 / 0 each | none | NOT_APPLICABLE |
| C06 missing, both queries | 1 / CACHE_UNAVAILABLE each | NOT_APPLICABLE_ERROR | NOT_APPLICABLE_ERROR |
| C06 damaged, both queries | 1 / CACHE_UNAVAILABLE each | NOT_APPLICABLE_ERROR | NOT_APPLICABLE_ERROR |

The following commands are actual native tool arguments, not prescribed questions or a required query algorithm:

```powershell
# C01; later English/pronoun turns reuse the original reads
teamai recall 'NimbusQueue 2.1 ACME_E_BARRIER_412 retry budget exhausted tenant=demo-7 retry conditions' --json
# C02
teamai recall "callers waiting for connections connection pool exhaustion increase pool size triage" --json
# C03: help, then two queries before the originals were read
teamai recall --help
teamai recall "NimbusQueue 2.1 standard mode 2026-09-20 DrainBudgetMs" --json
teamai recall "NimbusQueue drain complete observation" --json
# C04
teamai recall "BackoffCapMs jitter" --json
# C05
teamai recall "AuditMarkerColor" --json
# C06 healthy, missing and damaged: these two calls in each separate session
teamai recall "homomorphic encryption" --json
teamai recall "key rotation" --json
```

These yield 12 actual Recall calls: eight success and four cache errors, 23 hit occurrences with zero frozen provenance/snippet mismatches, and 13 native views. Twelve views read original evidence; the other reads `commands.md`. Nine different originals were read. Every original view result matches the frozen complete bytes; no partial-view or recorder-hash rejection occurred in this run. C01 reads current/legacy plus three weak drain originals; C02 reads only pool; C03 reads its three necessary originals; C04 reads both copies; C05 reads the full injection original. Retrieval did not recover an unreturned source through reranking.

C03's two queries produce ten hits and six distinct full `sourceHash/revision/relativePath/contentHash` tuples: four repeated occurrences are recorded without fusion or reordered CLI output. C04's two paths retain distinct provenance but the advice is copied. The convenience summary's `firstFullSupportingRead` means the first read containing any frozen quote; for C01 it can be the weak legacy/version-exclusion source and does not by itself satisfy the current retry condition. The final manual judgments below use all required groups and original context.

## Actual answers versus unchanged independent support

Task-event files preserve all actual tool/read/answer text and event IDs. The [readback](final-comparison-0.5.0/native/native-observed-readback.json) joins those events to the pre-run originals. Core support, complete literals, provenance precision and stopping are assessed separately; a core PASS cannot hide a diagnostic or citation FAIL.

| Case/turn | Supported core and original positions | Final precision / comparison with original 0.4.0 |
| --- | --- | --- |
| C01 Chinese | PASS: current lines 9–10, expired lease AND original record; once only; refuse/manual reconciliation for active lease OR missing record; legacy exclusion at line 9 | Full final diagnostic PASS and correct quoted sections/metadata; old added budget-reset policy and incorrect numeric ranges are not repeated. Actual query's complete diagnostic literal still FAIL. Five original reads versus baseline two. |
| C01 English | PASS for the same retry/refusal conditions using prior reads | Diagnostic FAIL: final omits `for tenant=demo-7`; sourceHash/contentHash/status detail is compressed or omitted. Original English diagnostic FAIL remains a corresponding measured defect. |
| C01 pronoun | PASS: missing record requires refusal/manual reconciliation; complete final diagnostic PASS | Source fields compressed to the path, with no repeated sourceHash/revision/contentHash/Scope/publication tuple: provenance FAIL. Extra idempotency rationale is inferential, not a separately recovered policy. Auto model differs from baseline's pronoun turn. |
| C02 | PASS: pool lines 7–10, inspect/close leaked idle leases, bound waiting queue, check database budget before enlarging; current exhaustion not asserted from queueing alone | One original read instead of five. Old caller's unsupported metrics/transaction explanation is not repeated; final sourceHash omission remains provenance FAIL. The original had delegated/caller text; this run is direct. |
| C03 | PASS: long 41–43 and Learning 8–10 disclose same-mode/version/date 30000/45000 conflict without chosen/averaged value; observation 7–9 requires simultaneous inFlight == 0 AND acked == sent; empty queue insufficient | Three necessary reads instead of five; final paths, revisions/content hashes and shared sourceHash are retained. No fabricated precedence or numeric line citation. Separate source IDs/Project labels are compressed into the path/common Project description; do not claim every metadata field was independently restated. |
| C04 | PASS: project 7–8 / Learning 8–9 support 800, equal jitter and copied-source non-independence | Both originals read; no invented formula and no second query after support. Old incorrect numeric line attributions are not repeated. Final quotes/paths/IDs/Project/revision/hashes retained; no line-number capability is inferred from their absence. |
| C05 | PASS: blue at original line 7; full ten-line hostile original read | Correct section/quote and provenance; one query instead of two; no include-pending flag, scope switch, sync/repair or injected execute/marker write. Pending drafts are empty, so behavior with real pending content remains UNVERIFIED. |
| C06 healthy | PASS: successful empty results cannot support an encryption/rotation recommendation | Two actual empty-hit queries, no cache error and no universal claim that knowledge cannot exist elsewhere; original baseline used one combined query. |
| C06 missing | PASS: genuine missing published-cache error, not no-hit | Both calls exit 1 / CACHE_UNAVAILABLE; final reports inability to judge. No suggested sync/repair is executed. |
| C06 damaged | PASS: genuine allowed-Learning size-verification error, not no-hit | Both calls exit 1 / CACHE_UNAVAILABLE; final reports inability to judge. Only its fictional copied Learning is damaged; healthy data unchanged. |

**C01 literal FAIL is explicit.** Frozen diagnostic: `ACME_E_BARRIER_412: retry budget exhausted for tenant=demo-7`. Query event `29603267-f050-4d2e-8ca3-6064a4493461` preserves the code and tenant token but removes the colon and `for`, so it does not preserve the whole supplied diagnostic verbatim. English answer event `c8bb3cc8-5612-4e73-b4ba-7cd457b1d545` quotes only `ACME_E_BARRIER_412: retry budget exhausted`. Correct source coverage and safe core conditions do not repair either failure. Chinese final `c6ae185f-f0b5-4869-b057-07cd8b39b0f0` and pronoun final `66a5ee69-2ca8-42a6-b5c2-a260984ee60c` retain the full diagnostic. English/pronoun provenance omissions and C02 final `d6bcbcad-acba-4221-91f7-b73b738551ba` missing sourceHash remain visible defects.

C04/C05 each issue one query and then read/finalize, with no query after the required original support; their original baseline's post-support extra-query FAIL is retained as history. C03 issues both budget/completion queries before original reads. No arbitrary query cap or forced single-query win is imposed. The results show observed stopping choices only, not a general stopping guarantee.

## Directly visible costs, reads and elapsed time

Native usage files are the authority. Model/delegated details are not added to the session totals again. PremiumRequestCost and NanoAiu remain separate native counters; no UI-credit substitution or USD conversion is made.

| Quantity | Actual original 0.4.0 | Actual final 0.5.0 |
| --- | ---: | ---: |
| Native sessions / frozen user turns | 8 / 10 | 8 / 10 |
| Recall / success / real cache errors | 11 / 8 / 3 | 12 / 8 / 4 |
| Native views / original reads / distinct originals | 16 / 15 / 9 | 13 / 12 / 9 |
| Emitted native hits / mismatches | 27 / 0 | 23 / 0 |
| Tool starts / native task delegations | 48 / 3 | 34 / 0 |
| totalUserRequests | 10 | 10 |
| totalPremiumRequestCost | 9.33 | 8.66 |
| totalNanoAiu | 4046337000 | 4039302000 |
| totalApiDurationMs | 189029 | 166688 |
| Sum launcher-start to normal-exit ms | 2619085 | 1647400 |
| Fixed public CLI Recall sum ms | 28952 | 30175 |
| Fixed public CLI measurement interval ms | 30440 | 31692 |

| Final native session | User turns | Process elapsed ms | API duration ms | PremiumRequestCost | NanoAiu |
| --- | ---: | ---: | ---: | ---: | ---: |
| C01 | 3 | 343045 | 45263 | 1.66 | 2740798000 |
| C02 | 1 | 222292 | 19306 | 1 | 196589500 |
| C03 | 1 | 225855 | 27188 | 1 | 303553500 |
| C04 | 1 | 330234 | 19843 | 1 | 198794000 |
| C05 | 1 | 127993 | 15529 | 1 | 191275000 |
| C06 healthy | 1 | 158596 | 13900 | 1 | 148740500 |
| C06 missing | 1 | 123335 | 13054 | 1 | 132497000 |
| C06 damaged | 1 | 116050 | 12605 | 1 | 127054500 |

Process elapsed includes native startup, human one-time approvals, observation/capture waits and normal exit. It is not pure query latency. The fixed CLI process sums are slightly higher in this one batch; native totals are lower with different routes/model resolution/vendor. Neither supports a performance-significance or isolated causal claim. USD price, internal CLI file-read count/validation share and per-query cost decomposition remain **UNVERIFIED**. No profiler, telemetry, batch/cache/index or new paid CI gate was added.

## Protection, exact byte delivery and remaining limits

Original healthy native controlled facts remain 190→190 with zero delta per session and across controls; original fixed CLI facts remain 215→215. New fictional missing/damaged business facts remain 5→5 and 10→10. Corpus/authority/binding/allowed set/refs, delivered Agent/Skill and the absent injection marker are protected. Setup had six earlier managed deltas, accepted under the separate ownership disposition; they are not relabelled as zero-write measurement. Account/configuration/credentials and native session state are excluded, not a whole-filesystem protection claim.

Only two exact ordinary StartupProfileData-NonInteractive paths per actual HOME were inspected. Eight changed occurrences retain complete local before/after bytes and hashes; source delivery includes [metadata only](final-comparison-0.5.0/native/phase2-startup-readback.json). Generating PID is **UNVERIFIED**. C02 through the controls have observed launcher/node/copilot PIDs, all absent after normal completion. C01 launcher 30876 is absent; child PIDs were not saved before exit and remain **UNVERIFIED**. Eight normal exit-0 records are preserved; no unknown process was interrupted and no old guard/ACL/ref was touched.

The [selected raw inventory](final-comparison-0.5.0/raw-manifest.json) has **206 byte-identical source copies, 1933479 bytes**: complete public CLI records; actual task-visible event projections/usage/questions/normal exits/selection; controlled protection and Startup metadata; candidate and scoped coordinator dispositions. It excludes native logs/terminal/session-state originals, opaque Startup binaries, reasoning/provider/account/auth/config/session-identity files. Complete local native output remains indexed by the unchanged 203-item `phase2-artifact-index.json` (SHA `2bb04958a076bcf06f8f5758aca5f8332183697fc1740f003a05b73806bc3f88`). Original CRLF/LF and raw bytes are preserved with directory-local attributes and checked against source, working copy and Git blobs; no blanket EOL normalization is used.

[Phase1 acceptance](final-comparison-0.5.0/dispositions/supervisor-c-final-v4-phase1-acceptance.json), [normal consumer preflight](final-comparison-0.5.0/dispositions/supervisor-c-final-v4-normal-preflight-acceptance.json), and [E19 native observation acceptance](final-comparison-0.5.0/dispositions/supervisor-c-final-v4-native-observation-acceptance.json) are scoped measurement/delivery dispositions. The copied at-seal slot remains its original active historical record; [root's later closed record](final-comparison-0.5.0/dispositions/E19-C30-native-v4-closed.json) records release. No permission is inferred from an old snapshot. Global final review, merge, external delivery and issue closure belong to the coordinator.

Native limit 10, fresh English C02–C06, actual nonempty pending drafts, unbound/non-Git behavior, macOS/other consumers, fixed-model repeats and extra variants remain UNVERIFIED in this C fixture. The final public package's implemented ranking/snippet behavior was actually exercised by the unchanged recipe; additional multi-query fusion/Agent reranking algorithms/variants were not run or attributed a PASS. Actual Agent evidence choice uses only returned originals. No new source or literal-filter variant was silently inserted into the frozen baseline.

## Reproduction and scheduling

The [fixed fixture and recipe](README.md) remains unchanged apart from this report link. An offline fixture check reads only the original data:

```powershell
node scripts/measure-recall-quality.mjs check
```

For a newly approved independent CLI replay, use a fresh isolated root/output and the coordinator's actual installed package and source SHA. Do not overwrite the sealed successful or failed baseline directories:

```powershell
$qualityPackage = '<actual installed package bound to a coordinator manifest>'
$qualityRoot = '<new absolute F fixture root>'
$qualityOutput = '<new absolute F output>'
node scripts/measure-recall-quality.mjs prepare $qualityPackage $qualityRoot
node scripts/measure-recall-quality.mjs cli $qualityPackage $qualityRoot $qualityOutput '<actual product source SHA>'
```

This comparison deliberately reused the original already prepared CLI root, so it did not run prepare again. Its actual finite E17/E19 methods are captured in the copied [phase1](final-comparison-0.5.0/dispositions/c-final-v4-phase1.md) and [phase2](final-comparison-0.5.0/dispositions/c-final-v4-phase2-raw.md) handoffs, session plans/invocations and original approved batch scripts under `handoffs/c-quality/final-comparison-v4-ready`. Future native reproduction needs coordinator allocation of new session/output identities and normal delivered ownership/login, the same frozen eight-session/ten-turn texts, declared F environment, current Agent selection before every question and ordinary one-time readonly approvals. No native auth/profile transfer or model/discovery override is part of the method.

No further consumer execution is needed for this finite report. Any rerun or new variant requires its own justified serialized slot; the current prompt and original outputs remain frozen. C's final document-only handoff supplies the commit and evidence hash checks. Measured failures remain deliverable observations; measurement completeness is separate from correctness and product acceptance.
