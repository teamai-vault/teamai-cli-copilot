# Recall #30 measurement report

Status: UNVERIFIED — template only, no quality/consumer result is implied.

| Binding | Exact value / raw evidence pointer |
| --- | --- |
| Fixture commit / raw-manifest hash | UNVERIFIED |
| CLI source / package version / tarball SHA-256 | UNVERIFIED |
| Installed CLI / bundled Agent / delivered Agent hashes | UNVERIFIED |
| Agent receipt root / target / version / hash | UNVERIFIED |
| Resource source/revision / published Learning revision | UNVERIFIED |
| Actual allowed Scope / Project / pending state | UNVERIFIED |
| Official stable and actual Copilot/runtime/platform/consumer | UNVERIFIED |
| Actual model and raw selection event | UNVERIFIED |
| Protection before/after and separate native session writes | UNVERIFIED |

## Deterministic public CLI

Retain full raw stdout/stderr per invocation and cli-report.json. Do not replace its measured FAIL with the protocol exit status.

| Case / profile / query style | Actual query / requested limit | Necessary originals in first 5 / 10 | First three candidates / weak ones | Source/hash/line verification | Exit / elapsed time | Quality / protocol |
| --- | --- | --- | --- | --- | --- | --- |
| C01 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| C02 (+ Chinese query) | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| C03 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| C04 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| C05 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| C06 healthy / missing / damaged | UNVERIFIED | NOT_APPLICABLE | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |

Record individual required source ranks, not only a combined average. Preserve partial coverage of C03. Record repeated source tuples across actual queries, without reordering/fusing results. CLI original reads/final answers/model cost are not model-consumer observations.

## Actual packaged/delivered Agent

For every actual native case/session/turn, record the following with raw pointers:

- Frozen question variant/profile; exact session identity and start/end window.
- Native discovery/selection event and exact delivered definition/receipt.
- Actual queries, preserved anchors/English concepts, scope/limit, tool-call arguments/results and number of CLI queries.
- Candidate order/source tuples, actual deduplication and number of repeated queries/reads.
- Every native original read path, requested and returned ranges, actual distinct originals read, and missing/outside-snippet evidence.
- Final selected evidence/order, exact claim-to-original support, original path/revision/hash/line/publication provenance, user-language final answer.
- Individual PASS/FAIL/UNVERIFIED for anchors, conditional/negative advice, contradictions, coverage, unsupported claims and execute/scope protection.
- Total observed time; directly visible native token/usage/cost fields. Other fields UNVERIFIED.
- Business/source/binding/allowed-set/ref before/after; native session writes and any Git checkpoint mutation in a separate row.

| Case | Queries / distinct originals read / elapsed | Evidence coverage / supported final answer | Anchors, scope, injection, contradictions | Raw transcript / events | Result |
| --- | --- | --- | --- | --- | --- |
| C01 Chinese / English / prior reference | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| C02 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| C03 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| C04 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| C05 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| C06 healthy / missing / damaged | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |

Averages cannot conceal individual anchor changes, conflict omissions, fictitious provenance, scope enlargement or unauthorized execute. Original-source protection is independent of native-session writing.

## Unrun comparisons and limits

| Variant | Status / exact rerun requirement |
| --- | --- |
| Final integrated same-fixture public CLI | UNVERIFIED — bind approved candidate and run the unchanged recipe in a new output |
| Actual final packaged Agent / multi-query / evidence reordering | UNVERIFIED — observe implemented actual native query/read/answer behavior |
| BM25 initial ranking | UNVERIFIED — measure only after actual delivery |
| Best snippet | UNVERIFIED — compare returned original lines and necessary later evidence after implementation |
| Pending / other Scope combinations / macOS / other consumers | UNVERIFIED — outside this finite baseline run |
| Unavailable token/price/validation decomposition fields | UNVERIFIED — no new profiler/SDK/API |

Known baseline FAIL/REJECT: UNVERIFIED until actual runs; append every failure with its raw pointer.
Measurement deliverables: UNVERIFIED.
Product-wide acceptance: NOT_CLAIMED.
