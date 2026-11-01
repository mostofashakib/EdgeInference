# ADR 0004: Quota Accounting, Concurrency Controls, and Cancellation

## Status
Accepted

## Context
On a shared MacBook Pro running developer workflows alongside LLM inference, resource governance is essential to prevent workstation lockup or out-of-memory crashes.
Constraints:
- GPU inference with a 27B model dominates unified memory and compute bandwidth. Exactly 1 active inference request should run at any given time.
- Excess concurrency must queue up to a bounded capacity (2 slots) and immediately reject additional traffic with HTTP 429 (`inference_busy`).
- Daily quota limits (100 requests/day per key) must be durable, survive process restarts, and execute atomically without race conditions.
- Ordering principle: Requests that are rejected due to queue capacity or cancelled while waiting in line must never consume the user's daily quota allowance.
- Guaranteed resource cleanup: Active slots must be released immediately upon normal completion, upstream failure, or client disconnection, without risk of double-release bugs.

## Decision

1. **Embedded SQLite with WAL Mode for Quotas**:
   - `SqliteQuotaRepository` uses `better-sqlite3` in WAL mode (`journal_mode = WAL`, `synchronous = NORMAL`).
   - Reservations execute within an immediate transaction (`transaction.immediate()`), ensuring atomic read-and-increment operations that completely eliminate race conditions under concurrent requests.
   - Provides an atomic `rollback(keyId, period)` operation.
2. **In-Process Semaphore and Bounded Queue**:
   - `SemaphoreAdmissionController` implements an async semaphore with 1 active execution slot and a FIFO queue capped at 2 waiting requests.
   - Any request arriving when active count is 1 and queue length is 2 is rejected immediately with HTTP 429 (`ConcurrencyLimitError`).
3. **Cancellation & Quota Rollback Protocol**:
   - When `InferenceService` processes a request:
     1. It performs an atomic quota check and reservation.
     2. It requests an inference lease from `SemaphoreAdmissionController`.
     3. If admission fails (queue full) or the client aborts while waiting, `quotaService.rollback(keyId)` is invoked, restoring the user's daily balance before rethrowing the error.
     4. If admitted, the request executes with an `AbortSignal`.
     5. The lease is released in a `finally` block, protected against double-release.

## Consequences
- Guaranteed preservation of workstation stability: maximum 1 model inference execution at any time.
- Strict fairness: rejected or aborted requests do not burn daily request budgets.
- Zero database locking overhead during active model token generation.

