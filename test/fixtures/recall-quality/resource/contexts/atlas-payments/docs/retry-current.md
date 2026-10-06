---
title: NimbusQueue 2.1 retry safety
tags: [queue, lease]
---
# NimbusQueue 2.1

Diagnostic: `ACME_E_BARRIER_412: retry budget exhausted for tenant=demo-7`.
A lease-expiry symptom does not establish that every failed request can be replayed.
For NimbusQueue 2.1 in atlas-payments, retry once only when the lease has expired and the original idempotency record still exists.
If the lease is still active or the idempotency record is absent, do not retry; escalate for manual reconciliation.
Keep the original diagnostic and tenant token verbatim in incident notes.
This note supports no unconditional retry recommendation.
