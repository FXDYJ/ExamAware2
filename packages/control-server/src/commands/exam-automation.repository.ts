import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, lt, lte } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/client.js';
import { DatabaseService } from '../database/database.service.js';
import { examAutomation, type ExamAutomationRecord } from './exam-automation.schema.js';
import { examConfig } from '../exam-configs/exam-config.schema.js';

export const RUNNING_AUTOMATION_STATUSES = ['scheduled', 'preparing', 'active'] as const;

@Injectable()
export class ExamAutomationRepository {
  constructor(private readonly database: DatabaseService) {}

  async list() {
    const rows = await this.database.db
      .select({ plan: examAutomation, name: examConfig.name })
      .from(examAutomation)
      .innerJoin(examConfig, eq(examConfig.id, examAutomation.examConfigId))
      .where(isNull(examConfig.deletedAt))
      .orderBy(asc(examAutomation.startAt));
    return rows.map((row) => ({ ...row.plan, name: row.name }));
  }

  async get(examConfigId: string, transaction = this.database.db) {
    return (
      await transaction
        .select()
        .from(examAutomation)
        .where(eq(examAutomation.examConfigId, examConfigId))
    )[0];
  }

  async lock(transaction: DatabaseTransaction, examConfigId: string) {
    return (
      await transaction
        .select()
        .from(examAutomation)
        .where(eq(examAutomation.examConfigId, examConfigId))
        .for('update')
    )[0];
  }

  async save(transaction: DatabaseTransaction, record: ExamAutomationRecord) {
    await transaction
      .insert(examAutomation)
      .values(record)
      .onConflictDoUpdate({ target: examAutomation.examConfigId, set: record });
  }

  async update(
    transaction: DatabaseTransaction,
    examConfigId: string,
    patch: Partial<ExamAutomationRecord>
  ) {
    await transaction
      .update(examAutomation)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(examAutomation.examConfigId, examConfigId));
  }

  overlapping(transaction: DatabaseTransaction, prepareAt: Date, stopAt: Date) {
    return transaction
      .select()
      .from(examAutomation)
      .where(
        and(
          inArray(examAutomation.status, [...RUNNING_AUTOMATION_STATUSES]),
          gt(examAutomation.stopAt, prepareAt),
          lt(examAutomation.prepareAt, stopAt)
        )
      );
  }

  due(now: Date) {
    return this.database.db
      .select({ examConfigId: examAutomation.examConfigId })
      .from(examAutomation)
      .where(
        and(
          inArray(examAutomation.status, [...RUNNING_AUTOMATION_STATUSES]),
          lte(examAutomation.prepareAt, now)
        )
      );
  }
}
