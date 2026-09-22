# PrintScope API contract

Base `/api/printscope`; all endpoints require staff authentication and module access (admin bypass). Generated hooks are ready in `@workspace/api-client-react`.

| Endpoint | Hook |
|---|---|
| GET capabilities | useGetPrintscopeCapabilities |
| POST uploads | useCreatePrintscopeUpload |
| GET jobs | useListPrintscopeJobs |
| GET jobs/{id} | useGetPrintscopeJob |
| POST jobs/{id}/complete | useCompletePrintscopeUpload |
| POST jobs/{id}/reinspect | useReinspectPrintscopeJob |
| GET jobs/{id}/plates/{assetId} | useGetPrintscopePlate (prefer authenticated img src) |
| GET rules | useGetPrintscopeRules |
| PUT rules | useUpdatePrintscopeRules |
| GET rules/versions | useListPrintscopeRuleVersions |
| GET rules/versions/{id} | useGetPrintscopeRuleVersion |
| GET pilot | useGetPrintscopePilot |
| POST pilot/start | useStartPrintscopePilot |
| GET pilot/sources | useListPrintscopePilotSources |
| POST pilot/imports | useImportPrintscopePilotSource |
| GET pilot/jobs | useListPrintscopePilotJobs |
| GET pilot/jobs/{id}/reviews | useListPrintscopePilotReviews |
| POST pilot/jobs/{id}/reviews | useReviewPrintscopePilotJob |

Upload metadata is `{filename,byteSize,contentType}` (50 MiB maximum, PDF-compatible `.ai`). Response `{job,uploadURL}`. PUT bytes directly to uploadURL, then complete with no body. Never submit a storage path. Rerun creates a new job with current rules.

Jobs contain `id,state,filename,byteSize,sha256,ruleVersionId,submittedBy,createdAt,completedAt,parentJobId,result,error`. List response `{jobs,total}`, newest first, query `limit,offset`. Detail `result` is the full engine object unchanged except relative plate src values become scoped private API URLs. Preserve all eight statuses, completeness and choke warnings. No automatic approval.

Rules response `{id,rows,hash,createdBy,createdAt,editable}`. CSV rows are string-valued objects, including `enabled`, `expected`, `tolerance`. PUT `{expectedVersion,rows}` sends the full snapshot; 409 means reload before editing. `editable` provides per-code supported fields/threshold keys; unsupported algorithms are read-only.

Capabilities include `available,reason?,engineVersion?,measureDpi?,ghostscript?,mupdf?,maxUploadBytes,retention,assistedOnly`. Unavailable processing must not disable browsing existing history.

## Read-only production-artwork pilot

The pilot is opt-in and never starts from deployment, development activity, source browsing, or imports. An admin explicitly calls `POST /printscope/pilot/start`; the server assigns UTC `startedAt`, `endsAt` (exactly 14 days later), and `purgeAfter` (exactly 30 days after the end), and immutably pins the active rule version. Staff may browse sources, import during the active window, view jobs, and append reviews; only admins may start.

`GET /printscope/pilot/sources` reads only mirrored `pv_files` rows joined to `pv_orders`. It returns stable source identity, order/visual identity, filename/size, mirror timestamps, eligibility reasons, an opaque revision token, and `sourceGeneration` for exact mirrored-generation binding. It never returns source URLs or object paths. Eligibility requires `source_kind=production_file`, mirrored status/path, a PDF-compatible `.ai` filename, and at most 50 MiB; `public_pdf` is never treated as separation artwork.

Import sends `{pilotId,sourceId,revisionToken,expectedGeneration,expectedFilename,expectedBytes}`. The server re-reads and locks source metadata, rechecks the exact GCS generation, PDF magic, size, and full SHA-256, then makes an immutable create-only PrintScope-owned original. Idempotency is environment + pilot + stable source + content SHA + pinned rule version. Stale or unsupported inputs are explicit errors, never successful imports. Printavo, Dropbox, `pv_orders`, and `pv_files` are never mutated.

Reviews are append-only and allowed only for completed pilot jobs. A nonblank reason is required. Outcomes are `pass|flag|fail|uncertain`; the latest review determines metrics while all older reviews remain. The UI exposes bounded, newest-first history with `useListPrintscopePilotReviews(id, {limit,offset})`; `latestReview` on a job is only a summary and does not replace history. Comparable means latest `pass|flag|fail`; uncertain is separate. Matching/nonmatching compare the engine verdict to that latest comparable outcome. False clear means engine `pass` plus human `flag` or `fail`. Metrics retain explicit counts and a limitations list because engine checks can be incomplete.

After `purgeAfter`, environment-scoped cleanup deletes only the exact stored generations of pilot-owned originals and plate previews, including reruns, and marks `assetsExpiredAt`. Metadata, engine results/version, provenance, and reviews remain. Shared/manual originals, mirrored `pv_files`, and other environments are excluded. Expiry fences queued/processing work and plate serving; retries are batched and idempotent.

Cleanup additionally verifies that originals are under the exact environment/pilot `originals` namespace and each plate is under that job's exact `plates` namespace before deleting anything for the pilot. A scope mismatch is retained with `OWNERSHIP_SCOPE_VIOLATION` for operator review. If an otherwise valid pilot original is also referenced by a manual or still-retained job, cleanup intentionally preserves those shared bytes while expiring the pilot's asset exposure; it does not claim that shared object was deleted.

## Operations

Development schema is managed only through `lib/db/src/printscope-additive.sql`; no broad Drizzle push or destructive changes. Apply that additive SQL to the deployment database before release. Worker starts at API boot, probes dependencies, then consumes manual queue rows only. Environment partition is derived from Replit deployment identity; production and development cannot claim one another's jobs. Three interrupted attempts maximum, 90-second leases with 20-second heartbeat, 10-minute process-group deadline, one local active inspection, 20 outstanding reservations/jobs.

Originals and generated plates remain private. Manual PrintScope job assets have no automatic retention deletion. Explicitly started pilot-owned original copies and plate previews use the fixed pilot expiry described above; mirrored `pv_files` and all historical metadata are preserved. Failed manual upload reservations expire after one hour for queue admission. Worker capability is probed at boot; dependency fixes need an API restart. Unit checks: `cd artifacts/api-server && node test-printscope.mjs`.

The scoped real-storage development retention check is `pnpm --filter @workspace/api-server run test:printscope-retention-integration`. It uses an isolated test environment, creates only uniquely identified synthetic expired/decoy rows and exact-generation objects, verifies failure retry, ownership scope, shared-source preservation, and idempotency, then removes its own rows and objects without deleting the browser fixture.

The child process family is monitored through Linux `/proc` at one-second intervals, with a 1.5 GiB aggregate RSS cutoff in addition to the wrapper's per-process address-space bound. Lease loss aborts Python and fences plate uploads/finalization. Orphan cleanup is restricted to the current UUID attempt prefix; uncertain database commit outcomes retain assets rather than risk deleting completed results. Both originals and private plates are served/consumed with stored generations. Rule snapshot CSV SHA256 and row roundtrips are verified before every execution.

## Real development acceptance run

The isolated, loopback-only harness (`node test-printscope-integration.mjs` from the API artifact) ran all 13 manifest-pinned fixtures through real signed GCS upload, completion verification, queue claim, Python processing, database persistence and private asset reads. All 13 verdicts, all 481 per-rule statuses and all complete completeness objects matched their bundled goldens; all 43 generated plate URLs returned private image bytes. A fourteenth inspection reran the primary immutable original, obtained a new job ID with the same source generation, and left its old result unchanged; cross-job asset access returned 404. This exercised only synthetic test-app staff context, not production authentication.

The successful run took approximately 126 seconds. Exact harness-created temporary rows/objects were cleaned (13 jobs); one genuine completed primary fixture remains for staff preview: `24eed586-3dcc-4b52-b4bb-a04de2d53b49`, named `Genuine fixture validation - #22499 F OUTPUT.ai`. No active rules were edited. The initial harness run caught and fixed a real protocol mismatch: wrapper output must be an empty dedicated directory, separate from input and rules files.