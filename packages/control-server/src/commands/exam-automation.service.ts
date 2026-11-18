import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  createExamConfigPrepareCommand,
  createPlaybackActivateCommand,
  createPlaybackStopCommand,
  EXAM_CONFIG_ARTIFACT_MEDIA_TYPE,
  type ControlCommand
} from '@dsz-examaware/control-protocol';
import type { WriteContext } from '../api/write-context.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DatabaseTransaction } from '../database/client.js';
import { env } from '../config/env.js';
import { ExamConfigsRepository } from '../exam-configs/exam-configs.repository.js';
import { createExamConfigArtifactBytes } from '../exam-configs/exam-config-artifact.js';
import { ControlCommandsRepository } from './control-commands.repository.js';
import { ControlCommandsService } from './control-commands.service.js';
import {
  ExamAutomationRepository,
  RUNNING_AUTOMATION_STATUSES
} from './exam-automation.repository.js';
import type { ExamAutomationRecord } from './exam-automation.schema.js';
import type { SaveExamAutomationDto } from './dto/exam-automation.dto.js';

@Injectable()
export class ExamAutomationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ExamAutomationService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: ExamAutomationRepository,
    private readonly exams: ExamConfigsRepository,
    private readonly commands: ControlCommandsService,
    private readonly commandRecords: ControlCommandsRepository,
    private readonly audit: AuditService
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => this.run(), 2_000);
    this.timer.unref();
    this.run();
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.running;
  }

  private run() {
    if (this.running) return;
    this.running = this.tick()
      .catch((error) => this.logger.error('考试自动执行失败', error))
      .finally(() => {
        this.running = undefined;
      });
  }

  async get(examConfigId: string) {
    const plan = await this.repository.get(examConfigId);
    if (!plan) return null;
    const [prepare, activations] = await Promise.all([
      this.commandRecords.targets(plan.id),
      Promise.all(
        Object.values(plan.activationCommandIds).map((id) => this.commandRecords.targets(id))
      )
    ]);
    return {
      ...plan,
      preparedCount: prepare.filter((target) => target.status === 'succeeded').length,
      startedCount: activations.flat().filter((target) => target.status === 'succeeded').length,
      failedCount: [...prepare, ...activations.flat()].filter((target) =>
        ['failed', 'expired'].includes(target.status)
      ).length
    };
  }

  async save(examConfigId: string, input: SaveExamAutomationDto, context: WriteContext) {
    const prepareAt = new Date(input.prepareAt);
    const startAt = new Date(input.startAt);
    const stopAt = new Date(input.stopAt);
    if (
      ![input.prepareAt, input.startAt, input.stopAt].every((value) =>
        /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
      ) ||
      ![prepareAt, startAt, stopAt].every((value) => Number.isFinite(value.getTime())) ||
      startAt.getTime() <= Date.now() ||
      prepareAt > startAt ||
      startAt >= stopAt
    ) {
      throw new BadRequestException({
        code: 'invalid_automation_time',
        message:
          '开始时间须晚于当前时间，准备时间不得晚于开始时间，结束时间须晚于开始时间。时间必须包含时区。'
      });
    }
    await this.database.transaction(async (transaction) => {
      // Serialize planning across exams so two requests cannot reserve the same screen.
      await transaction.execute(sql`select pg_advisory_xact_lock(173817, 1)`);
      const current = await this.repository.lock(transaction, examConfigId);
      if (current && ['preparing', 'active'].includes(current.status)) {
        throw new ConflictException({
          code: 'automation_running',
          message: '请先取消正在执行的计划。'
        });
      }
      const exam = await this.exams.lockById(transaction, examConfigId);
      if (!exam || exam.deletedAt) throw new NotFoundException('考试不存在');
      if (['active', 'preparing'].includes(exam.status))
        throw new ConflictException('请先停止当前放映');
      const version = await this.exams.findVersion(examConfigId, exam.latestVersion);
      if (!version) throw new NotFoundException('考试版本不存在');
      const id = randomUUID();
      const deviceIds = await this.commands.resolveTargets(
        { deviceIds: exam.assignedDeviceIds, partitionNodeIds: exam.assignedPartitionNodeIds },
        createPlaybackActivateCommand({ deploymentId: id, examConfigVersionId: version.id }),
        true
      );
      const overlaps = await this.repository.overlapping(transaction, prepareAt, stopAt);
      if (
        overlaps.some(
          (plan) =>
            plan.examConfigId !== examConfigId &&
            plan.deviceIds.some((deviceId) => deviceIds.includes(deviceId))
        )
      ) {
        throw new ConflictException({
          code: 'automation_device_conflict',
          message: '目标设备已有时间重叠的执行计划，请调整准备或结束时间。'
        });
      }
      const plan: ExamAutomationRecord = {
        examConfigId,
        id,
        version: version.version,
        deviceIds,
        activationCommandIds: Object.fromEntries(
          deviceIds.map((deviceId) => [deviceId, randomUUID()])
        ),
        stopCommandId: randomUUID(),
        publicOrigin: env.devicePublicOrigin ?? context.publicOrigin ?? env.betterAuthUrl,
        prepareAt,
        startAt,
        stopAt,
        status: 'scheduled',
        lastError: null,
        createdBy: context.actorUserId,
        updatedAt: new Date()
      };
      await this.repository.save(transaction, plan);
      await this.audit.record(transaction, {
        ...context,
        action: 'exam-automation.scheduled',
        resourceType: 'exam-config',
        resourceId: examConfigId,
        metadata: {
          version: plan.version,
          deviceIds,
          prepareAt: input.prepareAt,
          startAt: input.startAt,
          stopAt: input.stopAt
        }
      });
    });
    return this.get(examConfigId);
  }

  async cancel(examConfigId: string, context: WriteContext) {
    await this.database.transaction(async (transaction) => {
      const plan = await this.repository.lock(transaction, examConfigId);
      if (
        !plan ||
        !RUNNING_AUTOMATION_STATUSES.includes(
          plan.status as (typeof RUNNING_AUTOMATION_STATUSES)[number]
        )
      )
        return;
      await this.finish(plan, transaction, 'cancelled');
      await this.audit.record(transaction, {
        ...context,
        action: 'exam-automation.cancelled',
        resourceType: 'exam-config',
        resourceId: examConfigId,
        metadata: { deploymentId: plan.id }
      });
    });
    return this.get(examConfigId);
  }

  async tick(now = new Date()): Promise<void> {
    const due = await this.repository.due(now);
    for (const { examConfigId } of due) {
      try {
        await this.database.transaction(async (transaction) => {
          const [lock] = await transaction.execute<{ locked: boolean }>(
            sql`select pg_try_advisory_xact_lock(173818, hashtext(${examConfigId})) as locked`
          );
          if (!lock?.locked) return;
          const plan = await this.repository.lock(transaction, examConfigId);
          if (
            !plan ||
            !RUNNING_AUTOMATION_STATUSES.includes(
              plan.status as (typeof RUNNING_AUTOMATION_STATUSES)[number]
            )
          )
            return;
          try {
            await this.advance(plan, transaction, now);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`考试 ${examConfigId} 自动执行失败，将重试`, error);
            await this.repository.update(transaction, examConfigId, { lastError: message });
          }
        });
      } catch (error) {
        this.logger.error(`考试 ${examConfigId} 执行事务失败，将重试`, error);
      }
    }
  }

  private async advance(plan: ExamAutomationRecord, transaction: DatabaseTransaction, now: Date) {
    const exam = await this.exams.findById(plan.examConfigId);
    if (!exam) {
      await this.finish(plan, transaction, 'cancelled');
      return;
    }
    if (now >= plan.stopAt) {
      await this.finish(plan, transaction, 'completed');
      return;
    }
    const version = await this.exams.findVersion(plan.examConfigId, plan.version);
    if (!version) throw new Error('执行计划的考试版本已丢失');
    const artifact = createExamConfigArtifactBytes(version.content);
    await this.issueOnce(
      plan,
      plan.id,
      createExamConfigPrepareCommand({
        deploymentId: plan.id,
        examConfigId: plan.examConfigId,
        examConfigVersionId: version.id,
        artifact: {
          url: new URL(
            `/api/v1/device-artifacts/exam-configs/${plan.examConfigId}/versions/${plan.version}?deploymentId=${plan.id}`,
            plan.publicOrigin
          ).toString(),
          mediaType: EXAM_CONFIG_ARTIFACT_MEDIA_TYPE,
          sizeBytes: artifact.body.byteLength,
          sha256: artifact.sha256,
          expiresAt: plan.stopAt.toISOString()
        }
      }),
      plan.deviceIds,
      plan.stopAt
    );
    await this.retryDelivery(plan.id, now);
    const prepared = await this.commandRecords.targets(plan.id);
    const errors = prepared
      .filter((target) => target.status === 'failed')
      .map((target) => target.errorMessage)
      .filter(Boolean);
    let status = plan.status === 'active' ? ('active' as const) : ('preparing' as const);
    if (now >= plan.startAt) {
      // Each prepared screen starts independently, including screens that came online late.
      for (const target of prepared.filter((target) => target.status === 'succeeded')) {
        const commandId = plan.activationCommandIds[target.deviceId]!;
        await this.issueOnce(
          plan,
          commandId,
          createPlaybackActivateCommand({ deploymentId: plan.id, examConfigVersionId: version.id }),
          [target.deviceId],
          plan.stopAt
        );
        await this.retryDelivery(commandId, now);
        const results = await this.commandRecords.targets(commandId);
        if (results.some((result) => result.status === 'succeeded')) status = 'active';
        errors.push(
          ...results
            .filter((result) => result.status === 'failed')
            .map((result) => result.errorMessage)
            .filter(Boolean)
        );
      }
    }
    await this.exams.setStatus(plan.examConfigId, status);
    await this.repository.update(transaction, plan.examConfigId, {
      status,
      lastError: errors.join('；') || null
    });
  }

  private async issueOnce(
    plan: ExamAutomationRecord,
    id: string,
    command: ControlCommand,
    deviceIds: string[],
    expiresAt: Date
  ) {
    if (await this.commandRecords.findById(id)) return;
    await this.commands.issue(
      command,
      { deviceIds, partitionNodeIds: [] },
      expiresAt,
      { actorUserId: plan.createdBy, requestId: plan.id },
      id,
      { validateTargetCapabilities: false }
    );
  }

  private async retryDelivery(commandId: string, now: Date) {
    await this.commandRecords.retryFailed(commandId, now);
    const targets = await this.commandRecords.targets(commandId);
    for (const target of targets.filter((target) =>
      ['pending', 'delivered', 'acknowledged'].includes(target.status)
    )) {
      await this.commands.deliverPending(target.deviceId);
    }
  }

  private async finish(
    plan: ExamAutomationRecord,
    transaction: DatabaseTransaction,
    status: 'completed' | 'cancelled'
  ) {
    await this.commandRecords.cancel([plan.id, ...Object.values(plan.activationCommandIds)]);
    if (await this.commandRecords.findById(plan.id)) {
      await this.issueOnce(
        plan,
        plan.stopCommandId,
        createPlaybackStopCommand({
          deploymentId: plan.id,
          reason: status === 'cancelled' ? '执行计划已取消' : '执行计划已结束'
        }),
        plan.deviceIds,
        new Date(Date.now() + 86_400_000)
      );
    }
    await this.exams.setStatus(plan.examConfigId, 'completed');
    await this.repository.update(transaction, plan.examConfigId, { status, lastError: null });
  }
}
