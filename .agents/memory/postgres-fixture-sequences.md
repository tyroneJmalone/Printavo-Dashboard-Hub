---
name: PostgreSQL fixture sequence isolation
description: Temporary tables can still advance public sequences when defaults are copied.
---

Temporary fixture tables must use their own temporary sequences rather than
copying public nextval defaults.

**Why:** CREATE TEMP TABLE LIKE INCLUDING DEFAULTS can retain a public serial
sequence reference. Test inserts then advance that real sequence even inside
a rolled-back transaction; sequence increments are not transactional.

**How to apply:** Override serial defaults with temp-schema sequences before
fixture inserts. Do not reset public sequences afterward, which could conflict
with concurrent legitimate inserts.