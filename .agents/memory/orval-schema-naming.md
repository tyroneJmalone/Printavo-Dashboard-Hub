---
name: Orval component schema naming
description: OpenAPI component schemas for request bodies must be named ...Request, never ...Body — collides with orval's generated zod export.
---

Rule: in `lib/api-spec/openapi.yaml`, name request-body component schemas `<Thing>Request`, never `<Thing>Body`.

**Why:** the zod codegen (orval) auto-generates a body schema named `<OperationId>Body` in `lib/api-zod/src/generated/api.ts`, and component schema types are exported from `generated/types.ts`. Both are re-exported from the package index, so a component schema named `...Body` that matches an operation's generated name breaks codegen with TS2308 "already exported a member". Hit with `MarkVendorOrderFailedBody` (operationId `markVendorOrderFailed`); renamed to `MarkVendorOrderFailedRequest` — matching the existing `VendorSubmitRequest` convention.

**How to apply:** whenever adding a POST/PUT/PATCH schema to openapi.yaml, use the `...Request` suffix. In route code, the zod validator to import is still the orval-generated `<OperationId>Body` name.
