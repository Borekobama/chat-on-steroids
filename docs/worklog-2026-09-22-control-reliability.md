# Control-service reliability verification

## Changes

Control completion now uses a dedicated `supervisor_task_finish` handler. The handler persists acknowledgement only after proving the delivered input, caller session, conversation, active turn, and delivery order. Final response delivery remains a separate check on the same turn. An unbound task can bind to a session through its confirmed input event before the first status poll. Raw tool-call arguments cannot authorize completion.

Cancellation ownership survives restart; cancelled inputs are not replayed. Failed durable writes restore committed state. Status polling writes only transitions. Request receipts are retained rather than evicted by count, preserving deduplication and cancellation ownership.

The configured command sandbox now wraps unified pipe and PTY execution. Launch validation checks canonical paths and executable availability. Read-only broker requests have validated timeouts, two concurrent slots, and process-group cleanup even when the leader has exited.

## Evidence

- TypeScript checking, public-history privacy, license notices, and native-source metadata checks passed.
- `npm run verify` passed: main suite 5,752 passed / 111 skipped; serialized desktop and shutdown suites 6 passed / 20 skipped. Total: 5,758 passed / 131 skipped. Skipped native checks are not live desktop evidence.
- Dedicated completion regression: 26 tests passed.
- macOS arm64 package built. Bundle metadata/signature and packaged native runtime smoke checks passed.
- Installed application archive matched the packaged archive. A rollback copy was retained before replacement.
- A direct sandbox sentinel confirmed allowed project writes and denied home-directory writes.
- Manual diff and duplicate-logic review completed. Automated Slopo review could not run because its configuration did not match.

## Limits

The sandbox sentinel covers the named operations, not every filesystem exception. Transport tests use a fake wrapper and do not establish provider authentication or quota availability. No new live model task was submitted.

Provider retry turns without exact input ownership fail closed. Task history has no automatic retention bound. HTTP disconnect and application shutdown do not yet cancel read-only broker work through a shared owner; timeout and process cleanup provide the current bound. Health describes configured capability availability, not successful provider execution. User sandbox settings were preserved.
