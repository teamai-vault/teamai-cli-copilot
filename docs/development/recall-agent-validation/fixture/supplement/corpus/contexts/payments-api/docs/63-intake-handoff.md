---
title: IntakeSlot handling policy
tags: [IntakeSlot, handoff]
---
# IntakeSlot handling policy

HANDOFF_BUDGET_WAIT_64: IntakeSlot cannot resume after account rollover.

For intake mode V6, after the previous holder has stopped, the local wait is 9 ms. If either fact is unconfirmed or false, this note defines no alternative wait and does not establish eligibility.

Those local facts and the delay do not complete the evidence. This policy additionally requires gate C2 in the BudgetLatch clearance certificate to be reconciled; the certificate's definition is in contexts/payments-api/docs/82-budget-clearance.md. That memo complements this policy for this handoff.

If C2 is not established as reconciled, leave eligibility unresolved. This note describes conditions; it does not authorize executing the operation.
