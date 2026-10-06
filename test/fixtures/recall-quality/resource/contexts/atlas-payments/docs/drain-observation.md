---
title: Drain completion observation
tags: [drain, acknowledgement]
---
# Drain observation

For NimbusQueue 2.1 standard mode, completion requires both inFlight == 0 and acked == sent in the same observation window.
An empty waiting queue alone is insufficient.
This note supplies the completion condition, not a value for DrainBudgetMs.
