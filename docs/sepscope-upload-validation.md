# SepScope batch uploads and readiness — 2026-09-22

The visible module name is SepScope. Existing routes, internal module keys, inspection identities, and storage namespaces remain compatible with PrintScope history.

## Verified in development

- Browser selection of two valid PDF-compatible `.ai` files submitted both; an invalid `.txt` was independently rejected.
- Both inspections completed with plate previews. Reload showed one inspection per selected valid file.
- Browser testing did not inject a failed PUT. Four Node regression tests against the shared upload orchestrator separately verify reservation reuse after PUT failure, completion-stage retries without another PUT, exclusion of already-submitted items, and recovery after a lost completion response.
- API readiness/signing tests and frontend/backend typechecks passed.
- Test-owned inspection rows, objects, and synthetic staff were cleaned up.

## Production evidence and limitation

The published application returned repeated upload 503s before creating jobs or rule versions. That narrows the failure to readiness or initial rule setup, before upload signing. The original build discarded probe errors, so the exact production prerequisite failure was not recoverable from its logs.

The known recovery defect is corrected: a failed startup readiness probe no longer disables processing indefinitely. Readiness GETs and the worker can retry with a bounded interval and single-flight protection, and the UI refreshes unavailable readiness. Safe diagnostic codes now distinguish missing Python/renderer dependencies, failed renderer probes, and other execution failures without exposing raw stderr or storage credentials.

These changes have not been verified in the published runtime. Inspect the new startup/recovery logs after publishing before claiming the production upload issue is fully resolved.