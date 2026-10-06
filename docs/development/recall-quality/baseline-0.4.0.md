# Recall #30 — actual CLI 0.4.0 baseline (2026-10-05)

The corrected v2 run executed 34 sequential installed public Recall calls and three public version/help/projects observations. All 34 query protocols and all 22 positive required-source coverage observations passed. Every necessary original entered the requested first 5 and first 10, with the independently frozen alternatives in C04. This is source recall coverage. Answer quality, bilingual Agent conversion, original-reading behavior, injection resistance and real packaged Agent consumption remain **UNVERIFIED**.

Measured quality is mixed: a legacy source ranks above the correct incident note for the frozen C01 keywords, and sentence queries produce more noise in C02/C04/C05/C06. None of the positive-case snippets contains its complete independently frozen supporting quote. The C03 budget decision remains outside its returned lines. These observations and limitations are retained; no ranking, query transformation or production Agent was changed.

## Exact bindings

| Item | Value |
| --- | --- |
| Product source | 0fb99a7b065de71eb683d774231b518971b57e8c |
| Product version | 0.4.0 |
| Tarball SHA-256 | dea321f1fc9fb030fc18af398bcdb796d8cec7473c085e23be97eb3ca59aded6 |
| Installed compiled CLI SHA-256 | dc1fae834fb9933c1d702d99bee3196e578f661079046dfa10a97e2acc0426a2 |
| Bundled original Agent SHA-256 | 7e8edba317dde8758d3f238e1845fecb6206d93c00667df4ab8cbe72e7f270e4 |
| Frozen fixture commit / subtree | 12d8c6fe7d743ba8fc4901997c2e210473ca2a70 / d185a284718659d296afa2f93cea7f225bfb41b5 |
| Full original 22-file raw manifest digest | 37c2bbb2264b11755d05710ecaba1a3f94d10217cae6c6c556c18abd533fbeb7 |
| Executed v2 recipe | fa6b85112ed0548282a4d69dd8a6a782edfbd876 |
| V2 resource revision | d54b51b2f0432bbf1f5708509f6ae978a203be8a |
| V2 published Learning revision | cf573d619178f5b29773ac7c616a231e789eeb75 |
| V2 sourceHash | 6ec78d01758a4fec3859f9884059d3008a46eb69623d523f7464a3d2ad5ceb82 |
| Actual successful scope | workspace / atlas-payments; published only, pending not exercised |
| Active/inactive declared Projects | atlas-payments / atlas-other; public projects list marks only atlas-payments active |
| CLI runtime/platform | Node v24.15.0, win32, x64 |
| Native consumer/runtime/model | UNVERIFIED; no native/model session or delivery ran |

The immutable package binding was independently checked against the coordinator's package-manifest.json, including actual tarball/CLI/Agent bytes after measurement. The standalone cli-report.json retains its original unjoined tarball UNVERIFIED field; independent-readback.json supplies the observed manifest/hash join. No raw report field was overwritten.

The permitted corpus has 15 fictional originals: active project documents plus shared/active published Learnings. The inactive original is excluded. The v2 resource also has the required empty skills.yaml metadata (version 1, skills object {}). This non-evidence setup file is generated before the resource commit; it changes neither the 16 original files nor cases.json/sources.json/raw manifest. Original source revisions were recorded in prepared.json before query execution.

## Preserved first attempt and two corrections

V1, executed with recipe c1f4610, made all 37 allocated CLI invocations but failed to load the fictional Marketplace because its required skills.yaml was absent. All 34 Recall calls returned exit 1 / stdout JSON RECALL_FAILED / empty stderr. Version and help exited 0; projects list exited 1. The raw recorder consequently reports 34 protocol FAIL and 22 coverage FAIL. This is a real **fixture setup FAIL**; ranking/answer quality was not exercised in v1. The raw FAIL is preserved in baseline-0.4.0/v1-cli-report.json and its original batch output.

V1 source revision was 21cce3e7529f728123e8d61d13ad670003886f09, Learning revision cf573d619178f5b29773ac7c616a231e789eeb75, sourceHash fe0b2dedc4df21b75fc8a62a20622ba77eb348e27ca2fb4cb5e5e65fb00e6829. Its protected before/after snapshots are unchanged. The v1 directory was never overwritten or repaired.

Correction 1 (c1f4610) preceded actual measurement: parse nonzero Recall --json errors from stdout, validate schemaVersion/error.code/message and compare frozen expectedExit/expectedError. Old script 4c9106e, a RED rejection of valid stdout JSON, and 11 GREEN classification checks including E0 raw JSON errors remain preserved.

Correction 2 (fa6b851) generates the required empty Skill catalog and validates the actual installed package's existing catalog loader during preparation. A local format check preserves the original missing-file rejection and proves the empty-object format loads both fixture plugin kinds with zero Skills. No production/helper or frozen oracle changed. The coordinator authorized a new v2 root; all 34 case/profile/query/limit inputs exactly match v1.

## Candidate coverage and first-three noise

K = prewritten English keywords, S = complete English sentence, Z = ordinary Chinese CLI input. These are separate actual calls at limits 5 and 10. The supporting ranks below are the same at both limits. Weak refers to the frozen case-specific source set. Full query strings, all rank/ID/matchedTerms/snippet/provenance and raw stdout/stderr are retained for every call in baseline-0.4.0/v2-cli-report.json.

| Case / style | Required original ranks at limit 5 / 10 | Returned count at limit 5 / 10 | First three actual candidates; W = weak | Coverage |
| --- | --- | --- | --- | --- |
| C01 K | retry-current 2 / 2 | 5 / 10 | retry-legacy W; retry-current; noise-agenda W | PASS; top-1 task relevance FAIL |
| C01 S | retry-current 1 / 1 | 5 / 10 | retry-current; drain-long W; retry-legacy W | PASS; 2/3 first-three weak |
| C02 K | pool 1 / 1 | 1 / 1 | pool | PASS |
| C02 S | pool 2 / 2 | 5 / 10 | drain-long W; pool; backoff-copy W | PASS; top-1 task relevance FAIL |
| C02 Z | pool 1 / 1 | 1 / 1 | pool | PASS for this literal Chinese query |
| C03 K | observation 1 / 1; long document 2 / 2; conflicting Learning 3 / 3 | 3 / 3 | drain-observation; drain-long; shared Learning ending 001 | PASS for all three necessary sources |
| C03 S | conflicting Learning 1 / 1; long document 2 / 2; observation 3 / 3 | 5 / 10 | shared Learning ending 001; drain-long; drain-observation | PASS for all three necessary sources |
| C04 K | document 1 / 1; equivalent Learning 2 / 2 | 2 / 2 | backoff-copy; shared Learning ending 002 | PASS for the frozen alternative group |
| C04 S | document 1 / 1; equivalent Learning 2 / 2 | 5 / 10 | backoff-copy; shared Learning ending 002; pool W | PASS; copied evidence remains duplicated |
| C05 K | injection 1 / 1 | 1 / 1 | injection | PASS for candidate coverage |
| C05 S | injection 4 / 4 | 5 / 10 | drain-long W; retry-current W; pool W | PASS; all first three weak / top-1 relevance FAIL |
| C06 healthy K | No supporting original exists | 0 / 0 | No candidate | PASS for actual healthy no-hit |
| C06 healthy S | No supporting original exists | 5 / 10 | drain-long W; shared Learning ending 001 W; pool W | Candidate relevance FAIL; protocol PASS |
| C06 missing K/S | Error before candidates | 0 / 0 | CACHE_UNAVAILABLE | PASS for frozen exit-1 error protocol |
| C06 damaged K/S | Error before candidates | 0 / 0 | CACHE_UNAVAILABLE | PASS for frozen exit-1 error protocol |

The version disambiguation limit of the independently prewritten human keyword recipe is explicit: C01 K and C03 K omit NimbusQueue 2.1, while their sentence variants preserve it. C01 K retains the complete diagnostic and the actual Project flag; C03 K retains DrainBudgetMs. This is a recorded task-anchor completeness **FAIL/limitation in the human recipe**, not an observed Agent conversion result. The immutable inputs are preserved for later comparisons. The C01 legacy-first observation cannot, by itself, isolate ranking from the omitted version qualifier.

The two query styles do not have a universal winner. The sentence improves the correct source's C01 rank from 2 to 1. Keywords return only the relevant source in C02/C05, and sentence queries introduce unrelated candidates. C03 retrieves all complementary/conflicting originals with either style, while their order differs. C06 demonstrates that unrelated lexical hits cannot support an encryption/key-rotation answer.

## Snippet evidence and complete-answer support

Exact source-byte hashes, source revision/path/Project/publication and raw original-line slices were independently checked for all **121 emitted hits**, with no mismatch. Correct provenance/line slices do not imply that the snippet contains the facts needed to answer.

| Necessary original | Actual returned original lines | Frozen supporting positions / observed gap |
| --- | --- | --- |
| C01 retry-current | 1–3 for K/S | Decision and refusal are at 9–10 within frozen 7–11; snippet contains no condition/diagnostic answer |
| C02 pool | 1–3 for K/S; 9–11 for Z | Full handling/budget rule is at 7–10; Z includes the Chinese leak reminder but omits the database-budget restriction |
| C03 drain-long | 1–3 for K/S | Necessary numeric decision is at 41 within frozen 40–43 |
| C03 conflicting shared Learning 001 | 2–4 for K/S | The 45000 statement and unresolved conflict are at 8–10 |
| C03 drain-observation | 1–3 for K/S | The simultaneous completion condition is at 7–9 |
| C04 backoff-copy | K 2–4, S 1–3 | Advice and copied-source limitation at 7–9 |
| C04 shared Learning 002 | K 3–5, S 2–4 | Advice/copy limitation at 8–9 |
| C05 injection | K 1–3, S 4–6 | Blue color and untrusted-command boundary at 7–10 |

Full frozen supporting-quote availability in the snippet: **FAIL** for these necessary originals. Original reads are required for the complete frozen answers. No model original read or final answer occurred, so necessary original-evidence read coverage and supported final answers remain **UNVERIFIED**. C03's two incompatible budget values must be disclosed when a real answer is measured; source coverage does not prove that a model will preserve the contradiction.

C05's protected marker stayed absent during deterministic CLI calls. Actual consumer treatment of the hostile original text and native execute restrictions is UNVERIFIED; no native read selected or executed that document.

## Repeated sources, no-hit and errors

C04's document and equivalent shared Learning recur across all four K/S × limit calls: eight relevant hit occurrences represent **two full sourceHash/revision/relativePath/contentHash tuples**, with six repeated occurrences. Copies do not establish independent corroboration. Their distinct paths and revisions are preserved in independent-readback.json. No source fusion, ranking or actual Agent deduplication was performed.

C06 healthy K returns exit 0 with an empty hits array at both actual limits. The healthy S returns 5/10 unrelated candidates; no source can support the requested procedure. Missing and damaged profiles each make four calls with exit 1 and stdout JSON schemaVersion 1 / CACHE_UNAVAILABLE, stderr empty. The missing error reports no verified cached snapshot; the damaged error reports snapshot size verification failure for the deliberately changed allowed shared Learning. Neither case becomes no-hit, and no sync/repair was performed.

The damaged test also establishes error-before-result behavior for a corrupted allowed Learning even though the narrow keyword query has no matching relevant source. No validation-time breakdown was collected.

## Actual time, reads and protection

| Observed quantity | V2 |
| --- | --- |
| Recall processes | 34 sequential, 26 healthy / 4 missing / 4 damaged |
| Additional actual public observations | 3, all exit 0; version 0.4.0, help, active Project list |
| Sum of Recall process elapsed time | 28,952 ms |
| Recorded measurement interval | 30,440 ms (protocol observations, query/log work and after snapshot included; setup/before snapshot excluded) |
| Process time by query style | K 13,213 ms; S 14,202 ms; Z 1,537 ms, for this exact batch only |
| Controlled protection facts | 215 identical before/after: 212 file hashes plus absent Agent/Skill targets and marker |
| Offline provenance / exact-line readback | 121 emitted hits checked; no mismatch |
| Actual native queries / distinct native originals read | NOT_APPLICABLE for CLI; native baseline UNVERIFIED |
| Internal CLI file-read count / validation-time share | UNVERIFIED; no profiler/instrumentation |
| Native token/model/price cost | UNVERIFIED; no native/model session ran |

V1 also consumed its real failed attempt: 34 Recall processes, 23,435 ms summed process time and 25,826 ms measurement interval. Across v1/v2, C ran **68 Recall calls plus 6 protocol observations**; do not report only the successful retry as total activity. Setup duration was not instrumented.

Protected hashes cover only new fictional resource/published/authority Git roots, workspace, .teamai configs/binding/cache profiles and selected delivered-target facts. Consumer/agents and consumer/skills are absent, as is workspace/injection-executed.txt. No credential files were read or copied, no old guard/ACL/ref/session was touched, and no approval/trust/discovery setting changed. Native-session writes are NOT_APPLICABLE to this CLI batch. Native whole-workspace checkpoint behavior remains UNVERIFIED.

## Raw delivery and continuation

Committed raw files under baseline-0.4.0/ retain the complete v1/v2 machine reports, protected snapshots and v2 independent readback. Original per-invocation streams and setup command outputs remain under the shared batch handoffs/c-quality/baseline-cli-v1 and baseline-cli-v2, plus prepare-baseline-vN and measure-baseline-cli-vN stdout/stderr files. The machine reports include every invocation's stdout/stderr verbatim as JSON strings; original log filenames are in rawPrefix.

The coordinator has released E1-CLI from the completed actual runs. C will run no additional prepare/CLI batch/native/model without the next assigned slot. The actual original 0.4.0 packaged/delivered Agent baseline requires E1-NATIVE separately. Bilingual/pronoun conversion, actual query/dedup/native reads/final answers, permissions and model/runtime cost evidence are all UNVERIFIED.

Final integrated candidate, Agent multi-query/reordering, BM25 and best snippet comparisons are UNVERIFIED. Use the unchanged fixture/corpus with a new output root and the candidate's independently bound source/package/Agent revisions. No product-wide PASS, release acceptance, universal semantic recall, pending/macOS/other-consumer acceptance or #30 completion is claimed.
