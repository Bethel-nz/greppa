import { pgTable, text, timestamp, jsonb, bigint, index, uniqueIndex, integer } from 'drizzle-orm/pg-core'
import { user } from './auth'

export const organizations = pgTable(
  'organizations',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    slugIdx: index('org_slug_idx').on(table.slug),
  }),
)

export const memberships = pgTable(
  'memberships',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    role: text('role').notNull().$type<'owner' | 'admin' | 'member'>(),
    groupIds: text('group_ids').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    // One membership per (user, org) so ACL resolution can never pick a wrong/duplicate row.
    userOrgUnique: uniqueIndex('membership_user_org_unique').on(table.userId, table.orgId),
    orgIdx: index('membership_org_idx').on(table.orgId),
  }),
)

export const documents = pgTable(
  'documents',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    sourceType: text('source_type').notNull(),
    sourceUrl: text('source_url'),
    status: text('status').notNull().default('pending'),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    r2Key: text('r2_key'),
    contentType: text('content_type'),
    fileName: text('file_name'),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }),
    indexedAt: timestamp('indexed_at', { withTimezone: true, mode: 'date' }),
    failedAt: timestamp('failed_at', { withTimezone: true, mode: 'date' }),
    failureReason: text('failure_reason'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index('documents_org_idx').on(table.orgId),
    ownerIdx: index('documents_owner_idx').on(table.ownerUserId),
    statusIdx: index('documents_status_idx').on(table.status),
  }),
)

export const memoryEvents = pgTable(
  'memory_events',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    documentId: text('document_id').references(() => documents.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('pending'),
    error: text('error'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index('memory_events_org_idx').on(table.orgId),
    userIdx: index('memory_events_user_idx').on(table.userId),
    documentIdx: index('memory_events_document_idx').on(table.documentId),
  }),
)

export const memorySnapshots = pgTable(
  'memory_snapshots',
  {
    id: text('id').primaryKey(),
    objectKey: text('object_key').notNull(),
    checksum: text('checksum'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
)

export const ingestionJobs = pgTable(
  'ingestion_jobs',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    triggerRunId: text('trigger_run_id'),
    triggerTaskId: text('trigger_task_id'),
    sourceType: text('source_type').notNull(),
    contentType: text('content_type').notNull(),
    fileName: text('file_name'),
    r2Key: text('r2_key'),
    sourceUrl: text('source_url'),
    status: text('status').notNull().default('pending'),
    progress: integer('progress').notNull().default(0),
    progressLabel: text('progress_label'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    failedAt: timestamp('failed_at', { withTimezone: true, mode: 'date' }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index('ingestion_jobs_org_idx').on(table.orgId),
    docIdx: index('ingestion_jobs_doc_idx').on(table.documentId),
    statusIdx: index('ingestion_jobs_status_idx').on(table.status),
  }),
)

/**
 * A scope is one isolated Memvid file (stored at scopes/{id}/memory.mv2 in R2).
 * Phase 1: every user has exactly one personal scope. The storage layer is
 * scope-agnostic; ownership and sharing live here, not in the object key, so a
 * personal scope can later become a shared workspace without moving the file.
 */
export const scopes = pgTable(
  'scopes',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull().$type<'personal' | 'workspace' | 'shared'>(),
    name: text('name').notNull(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    ownerOrgId: text('owner_org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    // One scope per (owner, name) so getOrCreatePersonalScope is idempotent under races.
    ownerNameUnique: uniqueIndex('scope_owner_name_unique').on(table.ownerUserId, table.name),
    ownerIdx: index('scopes_owner_idx').on(table.ownerUserId),
  }),
)

export const scopeMembers = pgTable(
  'scope_members',
  {
    id: text('id').primaryKey(),
    scopeId: text('scope_id')
      .notNull()
      .references(() => scopes.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull().$type<'owner' | 'editor' | 'viewer'>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    scopeUserUnique: uniqueIndex('scope_member_scope_user_unique').on(table.scopeId, table.userId),
    scopeIdx: index('scope_members_scope_idx').on(table.scopeId),
  }),
)

export const ingestionJobEvents = pgTable(
  'ingestion_job_events',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => ingestionJobs.id, { onDelete: 'cascade' }),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    message: text('message').notNull(),
    progress: integer('progress'),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    jobIdx: index('ingestion_job_events_job_idx').on(table.jobId),
    orgIdx: index('ingestion_job_events_org_idx').on(table.orgId),
  }),
)
