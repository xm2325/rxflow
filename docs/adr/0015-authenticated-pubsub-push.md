# ADR 0015: Authenticate Pub/Sub push before consumer side effects

## Decision

The downstream push boundary verifies the bearer identity token before decoding or applying an event. Verification checks an RS256 signature against a cached JWKS key plus issuer, audience, expected service-account email, expiry, issued-at time, and `email_verified`.

## Why

A valid Pub/Sub JSON envelope is not proof that Google Pub/Sub sent the request. Authentication and message validation are separate checks. An unauthenticated request must not be able to create a dedup marker or pharmacy projection side effect.

## Evidence

Local RSA/JWK tests verify valid tokens and reject tampering and the wrong audience. A handler-level test proves that a request without the bearer token returns `401` while the downstream processed-event count remains zero.

## Limit

The Google JWKS network fetch is unit-tested with injected HTTP. The repository has not run this consumer against a real authenticated Pub/Sub subscription.
