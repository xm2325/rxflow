# ADR 0017: Bound AI dependency latency and repeated failure

## Decision

The PA generator can be wrapped by a request timeout and a circuit breaker. The breaker opens after a configured number of consecutive failures, rejects calls while open, allows one half-open probe after the reset window, and closes after a successful probe.

## Why

Schema checks protect against bad output after a model returns. They do not protect the request path from a dependency that hangs or fails continuously. A timeout bounds one request. A circuit breaker reduces repeated calls to a known-unhealthy dependency.

## Evidence

A hanging generator is converted into the existing retryable PA workflow failure within the configured timeout. Separate tests prove open, cooldown, half-open, and recovery behavior, including rejection of a second concurrent half-open probe.

## Limit

`Promise.race` bounds the caller but cannot cancel an arbitrary underlying implementation. A real HTTP model adapter should also pass an `AbortSignal` to the network request.
