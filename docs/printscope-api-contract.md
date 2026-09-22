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

Upload metadata is `{filename,byteSize,contentType}` (50 MiB maximum, PDF-compatible `.ai`). Response `{job,uploadURL}`. PUT bytes directly to uploadURL, then complete with no body. Never submit a storage path. Rerun creates a new job with current rules.

Jobs contain `id,state,filename,byteSize,sha256,ruleVersionId,submittedBy,createdAt,completedAt,parentJobId,result,error`. List response `{jobs,total}`, newest first, query `limit,offset`. Detail `result` is the full engine object unchanged except relative plate src values become scoped private API URLs. Preserve all eight statuses, completeness and choke warnings. No automatic approval.

Rules response `{id,rows,hash,createdBy,createdAt,editable}`. CSV rows are string-valued objects, including `enabled`, `expected`, `tolerance`. PUT `{expectedVersion,rows}` sends the full snapshot; 409 means reload before editing. `editable` provides per-code supported fields/threshold keys; unsupported algorithms are read-only.

Capabilities include `available,reason?,engineVersion?,measureDpi?,ghostscript?,mupdf?,maxUploadBytes,retention,assistedOnly`. Unavailable processing must not disable browsing existing history. Retention defaults to no automatic deletion pending a business decision.

## Operations

Development schema was applied using only `lib/db/src/printscope-additive.sql` (two new tables and one index); no broad Drizzle push or destructive changes. Apply that additive SQL to the deployment database before release. Worker starts at API boot, probes dependencies, then consumes manual queue rows only. Environment partition is derived from Replit deployment identity; production and development cannot claim one another's jobs. Three interrupted attempts maximum, 90-second leases with 20-second heartbeat, 10-minute process-group deadline, one local active inspection, 20 outstanding reservations/jobs.

Originals and generated plates remain private. No automatic source/staging/history deletion is implemented pending retention decisions. Failed reservations expire after one hour for queue admission. Worker capability is probed at boot; dependency fixes need an API restart. Unit checks: `cd artifacts/api-server && node test-printscope.mjs`.

The child process family is monitored through Linux `/proc` at one-second intervals, with a 1.5 GiB aggregate RSS cutoff in addition to the wrapper's per-process address-space bound. Lease loss aborts Python and fences plate uploads/finalization. Orphan cleanup is restricted to the current UUID attempt prefix; uncertain database commit outcomes retain assets rather than risk deleting completed results. Both originals and private plates are served/consumed with stored generations. Rule snapshot CSV SHA256 and row roundtrips are verified before every execution.

## Real development acceptance run

The isolated, loopback-only harness (`node test-printscope-integration.mjs` from the API artifact) ran all 13 manifest-pinned fixtures through real signed GCS upload, completion verification, queue claim, Python processing, database persistence and private asset reads. All 13 verdicts, all 481 per-rule statuses and all complete completeness objects matched their bundled goldens; all 43 generated plate URLs returned private image bytes. A fourteenth inspection reran the primary immutable original, obtained a new job ID with the same source generation, and left its old result unchanged; cross-job asset access returned 404. This exercised only synthetic test-app staff context, not production authentication.

The successful run took approximately 126 seconds. Exact harness-created temporary rows/objects were cleaned (13 jobs); one genuine completed primary fixture remains for staff preview: `24eed586-3dcc-4b52-b4bb-a04de2d53b49`, named `Genuine fixture validation - #22499 F OUTPUT.ai`. No active rules were edited. The initial harness run caught and fixed a real protocol mismatch: wrapper output must be an empty dedicated directory, separate from input and rules files.