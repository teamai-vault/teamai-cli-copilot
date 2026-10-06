Event 1a33179d-da39-4366-9b7d-cf2513e65df4; agentId=ef46931d-2c77-4ac0-9d7f-8e11dd3715fc

## Findings

**User-confirmed:** State E4 and that the previous sender has stopped. The diagnostic is exactly: `REPLAY_GUARD_BUSY: RetryEnvelope cannot acquire generation lease after reconnect.`

The published `RetryEnvelope generation lease observations` document says under **Decision conditions**: “Only when the state label is exactly E4 and the previous sender has stopped may the operation be attempted again after 250 ms.” Given your confirmed facts, that note permits attempting again after 250 ms. It also says an unknown or false condition grants no retry permission and no alternative delay; a dashboard label alone is not enough to establish the conditions.

That retry condition does **not** by itself establish safety against duplicate sending. The **Producer epoch rule** says a stale owner epoch can cause a duplicate send when the former producer still owns an outstanding request marker, and that the operator must establish the former producer has relinquished that marker before treating the replacement as safe. It explicitly says elapsed delay alone does not establish relinquishment. Thus, the additional evidence needed is **evidence that the former producer relinquished its outstanding request marker**. “The previous sender has stopped” does not, by itself, confirm that.

## Source provenance

Recall searched with `--scope workspace --project payments-api`—the requested shared-learnings and `payments-api` docs/learnings scope. Results were published; pending drafts were not included. The relevant search queries were `RetryEnvelope REPLAY_GUARD_BUSY generation lease reconnect` (required the exact diagnostic) and `RetryEnvelope E4 previous sender stopped owner epoch stale duplicate sending`; the matching terms included `RetryEnvelope`, `REPLAY_GUARD_BUSY`, `E4`, `stale`, `owner`, `epoch`, and `duplicate`.

Recall reported both sources as **published**, Logical Project `payments-api`, revision `3df2318a88d551876cd587a21e4cf8435af08d3c`, source hash `698b4c8833e096c2e1ca1e016fb8d3eb615cf9d86600c0b51a9de7f35edcaf34`:

- **`doc:payments-api:contexts/payments-api/docs/40-replay-guard.md`** — path `contexts/payments-api/docs/40-replay-guard.md`; SHA-256/content hash `0e2751160489cddc7dacb81eb626a71581c0e663ed5c936cb7adf857a001ab25`. Read the **Decision conditions** section and the incident observation. Original file: `F:\agent-workspace\multiAgent\teamai-cli-customization\.tmp\recall-29-35\runtime\b\b29-v1\resource\contexts\payments-api\docs\40-replay-guard.md`.
- **`doc:payments-api:contexts/payments-api/docs/70-epoch-policy.md`** — path `contexts/payments-api/docs/70-epoch-policy.md`; SHA-256/content hash `d1c3e9d39ca87b5b9192d768ba19301fcd377875fd18c9ca71199295c4001fc1`. Read the **Producer epoch rule** section. Original file: `F:\agent-workspace\multiAgent\teamai-cli-customization\.tmp\recall-29-35\runtime\b\b29-v1\resource\contexts\payments-api\docs\70-epoch-policy.md`.

The original reads showed the cited section text; they did not independently calculate the hashes or establish that files remained unchanged after Recall returned its metadata. The read output had no explicit line labels, so citations are by section rather than estimated line number.

Event 032bf061-f426-461d-bad3-0d7065fbb247; agentId=parent

`REPLAY_GUARD_BUSY: RetryEnvelope cannot acquire generation lease after reconnect.`

The documented handling condition allows another attempt **after 250 ms only when the state is exactly E4 and the previous sender has stopped**. Both are confirmed here. But that condition alone does not establish that retrying is safe from duplicate sends: with a stale owner epoch, the former producer may still hold an outstanding request marker. Before treating the replacement as safe, obtain evidence that the former producer **relinquished that marker**. The previous sender stopping, or simply waiting, is not sufficient evidence of relinquishment.

**Sources:** [40-replay-guard.md](contexts/payments-api/docs/40-replay-guard.md), “Decision conditions”; [70-epoch-policy.md](contexts/payments-api/docs/70-epoch-policy.md), “Producer epoch rule.” Both were published in Logical Project `payments-api` at revision `3df2318a88d551876cd587a21e4cf8435af08d3c`.
