import { index, integer, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { knowledgeEntriesTable } from "./knowledgeEntries";

export const knowledgeSourcesTable = pgTable("knowledge_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(), // upload | google_drive
  name: text("name").notNull(),
  sourceUrl: text("source_url").notNull().default(""),
  driveFolderId: text("drive_folder_id"),
  status: text("status").notNull().default("active"),
  createdByEmail: text("created_by_email").notNull(),
  updatedByEmail: text("updated_by_email").notNull(),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("knowledge_sources_kind_status_idx").on(t.kind, t.status), uniqueIndex("knowledge_sources_drive_folder_idx").on(t.driveFolderId)]);

export const knowledgeSourceDocumentsTable = pgTable("knowledge_source_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").notNull().references(() => knowledgeSourcesTable.id, { onDelete: "cascade" }),
  externalFileId: text("external_file_id"),
  name: text("name").notNull(),
  mimeType: text("mime_type").notNull(),
  status: text("status").notNull().default("active"), // processing | active | deleted | error | stale
  driveRevision: text("drive_revision"),
  driveModifiedTime: timestamp("drive_modified_time", { withTimezone: true }),
  checksum: text("checksum").notNull(),
  extractedText: text("extracted_text").notNull().default(""),
  objectPath: text("object_path"),
  draftCount: integer("draft_count").notNull().default(0),
  lastError: text("last_error"),
  createdByEmail: text("created_by_email").notNull(),
  updatedByEmail: text("updated_by_email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("knowledge_source_documents_source_idx").on(t.sourceId),
  uniqueIndex("knowledge_source_documents_external_idx").on(t.sourceId, t.externalFileId),
  index("knowledge_source_documents_checksum_idx").on(t.checksum),
]);

export const knowledgeEntrySourcesTable = pgTable("knowledge_entry_sources", {
  entryId: uuid("entry_id").notNull().references(() => knowledgeEntriesTable.id, { onDelete: "cascade" }),
  documentId: uuid("document_id").notNull().references(() => knowledgeSourceDocumentsTable.id, { onDelete: "cascade" }),
  sectionKey: text("section_key").notNull(),
  stale: text("stale").notNull().default("false"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("knowledge_entry_sources_unique_idx").on(t.entryId, t.documentId, t.sectionKey), index("knowledge_entry_sources_document_idx").on(t.documentId)]);

export type KnowledgeSource = typeof knowledgeSourcesTable.$inferSelect;
export type KnowledgeSourceDocument = typeof knowledgeSourceDocumentsTable.$inferSelect;
export type KnowledgeEntrySource = typeof knowledgeEntrySourcesTable.$inferSelect;