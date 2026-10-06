---
title: Connection leases and waiting callers
tags: [connections, capacity]
---
# Pool exhaustion

When a queue of callers waits for connections, inspect idle leases before changing capacity.
Close leaked idle leases and bound the waiting queue; do not increase the pool limit without checking the database connection budget.
Saturation and exhaustion describe the same capacity problem in this note.
连接池耗尽：先排查空闲租约泄漏，再约束等待队列。
