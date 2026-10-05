---
title: NimbusQueue 2.1 drain reference
tags: [drain, shutdown]
---
# DrainBudgetMs operations

This reference concerns NimbusQueue 2.1 standard mode on 2026-09-20.
DrainBudgetMs appears here as an index entry; the operational decision is in the final section.

## Background
The shutdown review starts by listing the workers that share a single synthetic queue.
A queue owner records the start time and captures a plain text observation for later review.
The first section describes terminology rather than a configured drain budget.
A drain request is different from an immediate worker termination request.
The queue accepts existing acknowledgements while rejecting newly scheduled work.
Operators compare the acknowledgement count with the number of sent messages.
The examples use fictional workers and contain no actual account or host identifiers.
An observation timestamp is recorded alongside each count to avoid combining different windows.
Repeated observations are kept in their original order rather than averaged into one event.
The reference does not describe a database migration or an account authorization procedure.
The trace collection step is read-only and does not grant permission to change production state.
A review should distinguish a cancelled shutdown from an orderly drain.
A worker that has no current work can still hold an acknowledgement for an earlier send.
An empty waiting queue alone therefore does not establish completion.
The summary should preserve the source version and the original observation window.
The middle section intentionally supplies context without a numeric configuration decision.
Readers may need the later decision section even when this index entry was already retrieved.
Do not infer the configuration value from the title or from this background section.
A successful return code alone also does not establish that every acknowledgement has arrived.
A budget is a waiting limit, not a promise that the worker will finish within that limit.
After the limit expires, the on-call owner inspects the outstanding work before deciding further action.
This text specifies no permission escalation or automatic repair.
The original counts are evidence; a summary should not manufacture counts that are missing.
The account names used in this fixture are fictional and have no external dependencies.
A later note can conflict with this document even if both are discoverable in the same cache.
There is no declared precedence rule between a document and a published Learning.
A reader must preserve conflicting values instead of silently selecting the first candidate.
The next section contains the value supported by this particular original.

## Decision
For NimbusQueue 2.1 standard mode on 2026-09-20, DrainBudgetMs is 30000.
Completion must also be verified using the separate drain observation note.
This document supplies no rule that supersedes another same-version source.
