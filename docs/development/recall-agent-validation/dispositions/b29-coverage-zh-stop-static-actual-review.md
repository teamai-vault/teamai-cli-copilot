# B29 Chinese coverage: narrow actual behavior review

Reviewer: `/root/b33_line_capability_review`. Read-only actual transcript review, not final batch review. Candidate `8000bae22cf6a3490578e25e1af6b618e73267d5`, final-v3 delivered Agent `7e882003883ea008c30b9c567f77578e318077162ebbba090bcdf901fa27c48f`.

**Major: the example does not meet #29's stopping condition.** This judgment does not impose a three-query maximum. Actual full reads of `40-replay-guard.md` and `70-epoch-policy.md` ended at 01:18:43 and 01:18:53 UTC, covering the retry conditions and marker relinquishment rule. All four reads ended by 01:19:25. Q5, event `b8007168-b9e5-4048-8f28-8011087f2d86`, then repeated the known generation lease/E4/250 ms rule; result event `6baf2529-52aa-4a62-a058-f26f3e9bda53` introduced zero new source identities. No visible retrieval gap justifies that query. AC10 permits follow-ups only for grounded new clues or a correctable retrieval gap, and the profile's step5 already states this. Q4 can be explained by the newly read marker clue, but its parallel execution does not supply a new reason for Q5.

**Minor: the parent adds “一次”.** The original replay rule says “attempted again” without a retry-count budget. The parent wording can imply a count limit. Preserve the original answer; later answers should say “再次尝试”.

The child and parent otherwise establish correct core conditions, source identities/revision/hashes/publication/Project and observed sections. Neither borrows LeaseMux/Z8 conditions. The child carries full provenance; the parent omits the absolute returned path. Five actual read bodies match current originals. Normal exit and protected hashes do not cure the stop failure.

The reviewer executed only reads, JSON comparisons and hashing, all normal exit zero. Other nine B29 cases were not reviewed. One actual failure does not by itself prove an inevitable source defect. Root must retain this FAIL, finish the already active consumer normally, then decide a bounded correction and fresh actual retest.
