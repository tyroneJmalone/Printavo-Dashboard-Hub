---
name: Publishing expression indexes
description: Publish-time schema introspection can truncate PostgreSQL expression indexes.
---

Prefer stored generated search-vector columns with ordinary GIN column indexes over GIN expression indexes when the schema must pass through publishing.

**Why:** The publishing schema diff truncated valid to_tsvector expressions for customer, contact, and knowledge search, producing invalid SQL ending in tsvector_ops and blocking initial production schema creation. The development indexes themselves were valid.

**How to apply:** Inspect explainSchemaDiff after development schema changes. Verify the generated statements, not just Drizzle push. Generated tsvector columns preserved the expressions through the publishing diff; update search predicates to use those indexed columns. Never repair this by adding production DDL to startup or deployment build commands.