import { customType } from "drizzle-orm/pg-core";

/** PostgreSQL-maintained full-text search data; never supplied by callers. */
export const searchVector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});