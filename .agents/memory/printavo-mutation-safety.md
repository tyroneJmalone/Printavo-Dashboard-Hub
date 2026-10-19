---
name: Printavo non-idempotent mutation safety
description: Operational rule for Printavo creates and other writes that cannot safely be replayed
---

Non-idempotent Printavo writes get exactly one network attempt. Persist an exclusive local claim before the call, and never retry automatically after a timeout, disconnect, server crash, or any other ambiguous result.

**Why:** A transport failure cannot prove that Printavo rejected the mutation. Retrying can create duplicate customer-facing records, while treating the outcome as a normal failure encourages unsafe manual retries.

**How to apply:** Use the dedicated non-retrying mutation path, bind the action to the exact reviewed local revision, and move ambiguous or abandoned in-flight attempts to a locked `unknown` state that requires manual verification in Printavo. A narrowly proven GraphQL document-validation rejection (HTTP 200, no partial data, only explicit input-field validation errors) occurs before resolver execution and may release the claim after read-only verification; never generalize that exception to transport, timeout, partial-data, or execution errors.

For absolute line-item product-status setters, a fresh status check is best-effort, not an atomic compare-and-set against Printavo. Local database locks cannot protect against someone editing the same item directly upstream.

**Why:** The inspected Printavo line-item update contract does not provide a conditional version/status guard. A remote edit can occur between the read and the write.

**How to apply:** Keep the fresh check immediately before a one-attempt write, warn users to avoid concurrent upstream edits during bulk cleanup, and never describe local locks as guaranteeing protection from external writers. Reconcile ambiguous outcomes with reads rather than automatically replaying writes.

For calculator handoffs, separate the reviewed snapshot hash from the durable duplicate-operation identity. The latter must exclude derived append positions and browser-generated garment row ids.

**Why:** A successful or ambiguous group append changes the next available position; reopening a worksheet changes local row ids. Either can otherwise make the same proposed write appear new and bypass a duplicate/uncertainty hold.

**How to apply:** Bind confirmation to the full preview, but check a stable content-and-destination identity before every write. Re-previewing or rebuilding identical input must retain completed results and uncertain-write locks.