---
name: Printavo non-idempotent mutation safety
description: Operational rule for Printavo creates and other writes that cannot safely be replayed
---

Non-idempotent Printavo writes get exactly one network attempt. Persist an exclusive local claim before the call, and never retry automatically after a timeout, disconnect, server crash, or any other ambiguous result.

**Why:** A transport failure cannot prove that Printavo rejected the mutation. Retrying can create duplicate customer-facing records, while treating the outcome as a normal failure encourages unsafe manual retries.

**How to apply:** Use the dedicated non-retrying mutation path, bind the action to the exact reviewed local revision, and move ambiguous or abandoned in-flight attempts to a locked `unknown` state that requires manual verification in Printavo.