import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ControlCommand } from '@dsz-examaware/control-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExamAutomationService } from '../src/commands/exam-automation.service.js';
import type { ExamAutomationRecord } from '../src/commands/exam-automation.schema.js';

function setup() {
  const examId = randomUUID();
  const versionId = randomUUID();
  const deviceIds = [randomUUID(), randomUUID()];
  const state = {
    plan: null as ExamAutomationRecord | null,
    overlap: [] as ExamAutomationRecord[]
  };
  const records = new Map<
    string,
    {
      command: ControlCommand;
      cancelled: boolean;
      targets: { deviceId: string; status: string; errorMessage: string | null }[];
    }
  >();
  const transaction = { execute: vi.fn(async () => [{ locked: true }]) };
  const database = {
    transaction: async (work: (tx: unknown) => Promise<unknown>) => work(transaction)
  };
  const repository = {
    get: vi.fn(async () => state.plan),
    lock: vi.fn(async () => state.plan),
    save: vi.fn(async (_tx, plan) => {
      state.plan = plan;
    }),
    update: vi.fn(async (_tx, _id, patch) => {
      Object.assign(state.plan!, patch);
    }),
    overlapping: vi.fn(async () => state.overlap),
    due: vi.fn(async (now: Date) =>
      state.plan &&
      ['scheduled', 'preparing', 'active'].includes(state.plan.status) &&
      state.plan.prepareAt <= now
        ? [{ examConfigId: examId }]
        : []
    )
  };
  const exam = {
    id: examId,
    status: 'draft',
    latestVersion: 1,
    assignedDeviceIds: deviceIds,
    assignedPartitionNodeIds: []
  };
  const exams = {
    lockById: vi.fn(async () => exam),
    findById: vi.fn(async () => exam),
    findVersion: vi.fn(async () => ({
      id: versionId,
      version: 1,
      content: { examName: '无人值守', examInfos: [] }
    })),
    setStatus: vi.fn(async (_id, status) => {
      exam.status = status;
    })
  };
  const commandRecords = {
    findById: vi.fn(async (id: string) => records.get(id)),
    targets: vi.fn(async (id: string) => records.get(id)?.targets ?? []),
    retryFailed: vi.fn(),
    cancel: vi.fn(async (ids: string[]) => {
      ids.forEach((id) => {
        const record = records.get(id);
        if (record) record.cancelled = true;
      });
    })
  };
  const commands = {
    resolveTargets: vi.fn(async () => deviceIds),
    deliverPending: vi.fn(),
    issue: vi.fn(
      async (
        command: ControlCommand,
        selection: { deviceIds: string[] },
        _expiry,
        _context,
        id: string
      ) => {
        if (records.has(id)) throw new Error('Duplicate command ID');
        records.set(id, {
          command,
          cancelled: false,
          targets: selection.deviceIds.map((deviceId) => ({
            deviceId,
            status: 'pending',
            errorMessage: null
          }))
        });
      }
    )
  };
  const audit = { record: vi.fn() };
  const devices = {
    findByIds: vi.fn(async () =>
      deviceIds.map((id) => ({
        id,
        displayName: id,
        lifecycleStatus: 'active',
        lastSeenAt: new Date(),
        appVersion: '1.6.3',
        lastCapabilities: {
          commands: [
            { name: 'exam-deployment', version: 1 },
            { name: 'unattended-playback', version: 1 }
          ]
        },
        lastReportedState: { timeSync: { synchronized: true, offsetMs: 0 } }
      }))
    )
  };
  const create = () =>
    new ExamAutomationService(
      database as never,
      repository as never,
      exams as never,
      commands as never,
      commandRecords as never,
      audit as never,
      devices as never,
      { isOnline: () => true } as never
    );
  const service = create();
  const times = {
    prepareAt: '2030-01-01T00:01:00Z',
    startAt: '2030-01-01T00:02:00Z',
    stopAt: '2030-01-01T01:00:00Z',
    offlinePlayback: false,
    lateJoinMinutes: 0
  };
  const save = () =>
    service.save(examId, times, {
      actorUserId: 'admin',
      requestId: randomUUID(),
      publicOrigin: 'http://192.0.2.10:8219'
    });
  const target = (commandId: string, index: number, status: string) => {
    records.get(commandId)!.targets[index]!.status = status;
  };
  return {
    service,
    create,
    save,
    state,
    records,
    transaction,
    commands,
    commandRecords,
    exams,
    examId,
    deviceIds,
    devices,
    times,
    target
  };
}

describe('unattended exam execution', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches local timing only when offline playback was explicitly enabled', async () => {
    const f = setup();
    f.times.offlinePlayback = true;
    await f.save();
    await f.service.tick(new Date(f.times.prepareAt));
    const command = f.records.get(f.state.plan!.id)!.command;
    expect(command.type).toBe('exam-config.prepare');
    if (command.type === 'exam-config.prepare')
      expect(command.payload.automation).toEqual({
        startAt: new Date(f.times.startAt).toISOString(),
        stopAt: new Date(f.times.stopAt).toISOString(),
        latestStartAt: new Date(f.times.stopAt).toISOString()
      });
  });

  it('expires activation commands at the late join cutoff and skips later arrivals', async () => {
    const f = setup();
    f.times.lateJoinMinutes = 1;
    await f.save();
    await f.service.tick(new Date(f.times.prepareAt));
    const plan = f.state.plan!;
    f.target(plan.id, 0, 'succeeded');
    await f.service.tick(new Date('2030-01-01T00:02:15Z'));
    expect(f.commands.issue.mock.calls[1]![2]).toEqual(new Date('2030-01-01T00:03:00Z'));
    f.target(plan.id, 1, 'succeeded');
    await f.service.tick(new Date('2030-01-01T00:03:01Z'));
    expect(f.records.has(plan.activationCommandIds[f.deviceIds[1]!]!)).toBe(false);
  });

  it('checks online state, offline capability and clock health before an exam', async () => {
    const f = setup();
    await f.save();
    const healthy = await f.service.preflight(f.examId);
    expect(healthy.ready).toBe(2);
    f.devices.findByIds.mockImplementation(async () =>
      f.deviceIds.map((id) => ({
        id,
        displayName: id,
        lifecycleStatus: 'active',
        lastSeenAt: new Date('2029-12-31T00:00:00Z'),
        appVersion: '1.6.2',
        lastCapabilities: { commands: [] },
        lastReportedState: { timeSync: { synchronized: false, offsetMs: 10_000 } }
      }))
    );
    const stale = await f.service.preflight(f.examId);
    expect(stale.ready).toBe(0);
    expect(stale.devices[0]!.issues).toContain('设备离线');
    expect(stale.devices[0]!.issues).toContain('未确认时钟已同步');
  });

  it('persists fixed targets and does not prepare before the configured time', async () => {
    const fixture = setup();
    await fixture.save();
    await fixture.service.tick();
    expect(fixture.commands.issue).not.toHaveBeenCalled();
    expect(fixture.state.plan).toMatchObject({
      version: 1,
      deviceIds: fixture.deviceIds,
      status: 'scheduled'
    });
    await fixture.service.tick(new Date(fixture.times.prepareAt));
    const command = fixture.records.get(fixture.state.plan!.id)!.command;
    expect(command.type).toBe('exam-config.prepare');
    if (command.type !== 'exam-config.prepare') throw new Error('wrong command');
    expect(command.payload.artifact.url).toContain('http://192.0.2.10:8219/');
    expect(command.payload.artifact.expiresAt).toBe('2030-01-01T01:00:00.000Z');
    expect(fixture.records.size).toBe(1);
  });

  it('starts ready devices at the scheduled time without waiting for offline devices', async () => {
    const f = setup();
    await f.save();
    await f.service.tick(new Date(f.times.prepareAt));
    const plan = f.state.plan!;
    f.target(plan.id, 0, 'succeeded');
    await f.service.tick(new Date('2030-01-01T00:01:59Z'));
    expect(f.records.size).toBe(1);
    await f.service.tick(new Date(f.times.startAt));
    expect(f.records.get(plan.activationCommandIds[f.deviceIds[0]!]!)!.command.type).toBe(
      'playback.activate'
    );
    expect(f.records.has(plan.activationCommandIds[f.deviceIds[1]!]!)).toBe(false);
    f.target(plan.id, 1, 'succeeded');
    await f.service.tick(new Date('2030-01-01T00:03:00Z'));
    expect(f.records.has(plan.activationCommandIds[f.deviceIds[1]!]!)).toBe(true);
  });

  it('recovers after a service restart with stable command IDs', async () => {
    const f = setup();
    await f.save();
    await f.service.tick(new Date(f.times.prepareAt));
    const plan = f.state.plan!;
    f.target(plan.id, 0, 'succeeded');
    await f.service.tick(new Date(f.times.startAt));
    f.target(plan.activationCommandIds[f.deviceIds[0]!]!, 0, 'succeeded');
    await f.create().tick(new Date('2030-01-01T00:05:00Z'));
    expect(f.records.size).toBe(2);
    expect(f.state.plan!.status).toBe('active');
    expect(f.commandRecords.retryFailed).toHaveBeenCalled();
  });

  it('cancels pending preparation and activation and queues a stop command', async () => {
    const f = setup();
    await f.save();
    await f.service.tick(new Date(f.times.prepareAt));
    const id = f.state.plan!.id;
    await f.service.cancel(f.examId, { actorUserId: 'admin', requestId: randomUUID() });
    expect(f.records.get(id)!.cancelled).toBe(true);
    expect(f.state.plan!.status).toBe('cancelled');
    expect(f.records.get(f.state.plan!.stopCommandId)!.command.type).toBe('playback.stop');
    const count = f.records.size;
    await f.service.tick(new Date(f.times.startAt));
    expect(f.records.size).toBe(count);
  });

  it('never starts an expired plan even if the server was offline for the full window', async () => {
    const f = setup();
    await f.save();
    await f.service.tick(new Date('2030-01-01T02:00:00Z'));
    expect(f.commands.issue).not.toHaveBeenCalled();
    expect(f.state.plan!.status).toBe('completed');
  });

  it('stops once when the playback window ends', async () => {
    const f = setup();
    await f.save();
    await f.service.tick(new Date(f.times.prepareAt));
    await f.service.tick(new Date(f.times.stopAt));
    await f.create().tick(new Date('2030-01-01T02:00:00Z'));
    expect([...f.records.values()].map((record) => record.command.type)).toEqual([
      'exam-config.prepare',
      'playback.stop'
    ]);
    expect(f.state.plan!.status).toBe('completed');
  });

  it('records failures and retries without losing the scheduled task', async () => {
    const f = setup();
    await f.save();
    f.commands.issue.mockRejectedValueOnce(new Error('network unavailable'));
    await f.service.tick(new Date(f.times.prepareAt));
    expect(f.state.plan!.lastError).toContain('network unavailable');
    await f.create().tick(new Date(f.times.prepareAt));
    expect(f.records.size).toBe(1);
    expect(f.state.plan!.lastError).toBeNull();
  });

  it('does not execute a task owned by another worker', async () => {
    const f = setup();
    await f.save();
    f.transaction.execute.mockResolvedValueOnce([{ locked: false }]);
    await f.service.tick(new Date(f.times.prepareAt));
    expect(f.commands.issue).not.toHaveBeenCalled();
  });

  it('rejects device overlaps and time values without timezone offsets', async () => {
    const f = setup();
    await f.save();
    f.state.overlap = [{ ...f.state.plan!, examConfigId: randomUUID() }];
    await expect(f.save()).rejects.toThrow('目标设备已有时间重叠');
    await expect(
      f.service.save(
        f.examId,
        { ...f.times, startAt: '2030-01-01T00:02:00' },
        { actorUserId: 'admin', requestId: 'request' }
      )
    ).rejects.toThrow('时间必须包含时区');
  });
});
