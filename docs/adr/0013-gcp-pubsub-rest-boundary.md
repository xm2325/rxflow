# ADR 0013: Implement Pub/Sub through a small REST EventSink

Status: accepted for the reference GCP path

The Pub/Sub publisher uses the v1 publish REST endpoint and a short-lived OAuth access token obtained from the Google metadata server. Integration events are JSON-encoded then base64-encoded into message data; selected non-clinical metadata is duplicated in attributes for operations.

HTTP and token acquisition are injected for tests. The code does not prove a real GCP deployment; managed case storage and cloud integration tests are still required.
