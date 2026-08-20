# ADR 0006: Production startup guard and readiness

## Decision

RxFlow separates liveness from readiness. Production mode requires a configured persistent store. Readiness checks storage access and reports the current pending-outbox count. SIGTERM/SIGINT stop the periodic publisher, perform a final drain attempt, close SQLite, and stop the server.

## Why

An HTTP process can be alive while its state store is unavailable. It is also unsafe to let a production process silently fall back to volatile in-memory state. These checks make failure modes explicit and give an orchestrator a useful readiness signal.

## Limits

The current readiness check only tests the local state store. A later cloud adapter should also check required downstream dependencies without making every transient downstream issue remove all API capacity.
