---
title: Stale owner epoch and duplicate send
tags: [epoch, duplicate]
---
# Producer epoch rule

A stale owner epoch can cause duplicate send when the former producer still owns an outstanding request marker.
The operator must establish that the former producer has relinquished that marker before treating the replacement producer as safe.
An elapsed delay by itself does not establish relinquishment.
The rule complements the E4 state observation; it does not determine that state or approve changing project bindings.
