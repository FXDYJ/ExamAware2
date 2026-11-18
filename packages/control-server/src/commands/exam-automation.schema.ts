import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid
} from 'drizzle-orm/pg-core';
import { user } from '../database/auth-schema.js';
import { examConfig } from '../exam-configs/exam-config.schema.js';

export type AutomationStatus = 'scheduled' | 'preparing' | 'active' | 'completed' | 'cancelled';

export const examAutomation = pgTable(
  'exam_automation',
  {
    examConfigId: uuid('exam_config_id')
      .primaryKey()
      .references(() => examConfig.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull(),
    version: integer('version').notNull(),
    deviceIds: jsonb('device_ids').$type<string[]>().notNull(),
    activationCommandIds: jsonb('activation_command_ids').$type<Record<string, string>>().notNull(),
    stopCommandId: uuid('stop_command_id').notNull(),
    publicOrigin: text('public_origin').notNull(),
    prepareAt: timestamp('prepare_at', { withTimezone: true }).notNull(),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    stopAt: timestamp('stop_at', { withTimezone: true }).notNull(),
    offlinePlayback: boolean('offline_playback').default(false).notNull(),
    lateJoinMinutes: integer('late_join_minutes').default(0).notNull(),
    status: text('status').$type<AutomationStatus>().default('scheduled').notNull(),
    lastError: text('last_error'),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [index('exam_automation_due_idx').on(table.status, table.prepareAt)]
);

export type ExamAutomationRecord = typeof examAutomation.$inferSelect;
