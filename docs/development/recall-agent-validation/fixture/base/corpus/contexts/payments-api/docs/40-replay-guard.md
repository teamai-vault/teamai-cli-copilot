---
title: RetryEnvelope generation lease observations
tags: [RetryEnvelope, reconnect]
---
# Incident observation

Observed diagnostic:
REPLAY_GUARD_BUSY: RetryEnvelope cannot acquire generation lease after reconnect.

The incident field for an old producer is stale owner epoch. Its duplicate-send rule is documented separately.

## Timeline

T00: The transport was open.
T01: A disconnect was observed.
T02: A connection was established.
T03: The consumer kept the previous request marker.
T04: The observer kept its last sample.
T05: The operator examined the request marker.
T06: The incident record was retained.
T07: The observer recorded the next sample.
T08: The record retained the original component spelling.
T09: The incident field was recorded separately from the transport record.
T10: The observer recorded a stable sample.
T11: The operator compared the two samples.
T12: The incident record remained available.
T13: The observer recorded its final sample.
T14: The operator retained the before and after markers.
T15: The report retained the original diagnostic.
T16: The report ended the observation interval.
T17: The observer recorded completion.

## Decision conditions

Only when the state label is exactly E4 and the previous sender has stopped may the operation be attempted again after 250 ms.
If either condition is unknown or false, this note grants no retry permission and provides no alternative delay.
The same label on the dashboard alone does not establish these conditions.
