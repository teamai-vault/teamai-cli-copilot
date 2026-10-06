---
title: Legacy retry error request queue worker lease handbook
tags: [retry, error, request, queue, worker, lease, expired, idempotency]
---
# Legacy NimbusQueue 1.6

Diagnostic: `ACME_E_BARRIER_412: retry budget exhausted for tenant=demo-7`.
NimbusQueue 1.6 used a two-retry procedure after a worker timeout.
This archived procedure applies only to NimbusQueue 1.6 and is not a recommendation for NimbusQueue 2.1.
It does not establish whether a current idempotency record exists.
