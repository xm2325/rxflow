# ADR 0008: Atomic downstream event deduplication

## Decision

The synthetic downstream pharmacy consumer uses `eventId` as its deduplication key. For a routing event, the route projection and processed-event marker are committed in one transaction.

## Reason

The sender can crash after the receiver accepts an event but before the sender records success. A later attempt can therefore redeliver the same event. A processed-event marker alone is not enough if it is written in a separate transaction from the business side effect.

## Consequence

Duplicate delivery has no second route effect in the local projection. A forced failure between the projection update and dedup marker rolls the whole transaction back so a retry can safely process the event.
