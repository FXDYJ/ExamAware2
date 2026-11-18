import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfflinePlayback, type OfflineDeployment } from '../../../src/main/control/offlinePlayback'

const binding = 'http://192.0.2.10:8219/|device-one'
const record: OfflineDeployment = {
  binding,
  config: {
    examName: '离线执行',
    message: '按时作答',
    examInfos: [
      { name: '数学', start: '2030-01-01T00:00:10Z', end: '2030-01-01T00:01:00Z', alertTime: 1 }
    ]
  },
  payload: {
    deploymentId: '8c207082-a97f-43c7-a619-e0f7661093a1',
    examConfigId: 'f3f58c4f-9a61-4ba8-9dc7-692e3f4db1c7',
    examConfigVersionId: '3d5b30b9-ff49-40b0-b72f-ab670e39f2ad',
    artifact: {
      url: 'http://192.0.2.10:8219/exam',
      mediaType: 'application/vnd.examaware.exam-config+json',
      sizeBytes: 100,
      sha256: 'a'.repeat(64),
      expiresAt: '2030-01-01T00:01:00Z'
    },
    automation: {
      startAt: '2030-01-01T00:00:10Z',
      latestStartAt: '2030-01-01T00:00:40Z',
      stopAt: '2030-01-01T00:01:00Z'
    }
  }
}

function setup(input: unknown = []) {
  let disk = input
  const options = {
    binding: vi.fn((): string | undefined => binding),
    load: vi.fn(async () => disk),
    save: vi.fn(async (records: OfflineDeployment[]) => {
      disk = JSON.parse(JSON.stringify(records))
    }),
    install: vi.fn(),
    activate: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    error: vi.fn()
  }
  const controller = new OfflinePlayback(options)
  return { options, controller, disk: () => disk }
}

describe('offline exam execution', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('persists a downloaded exam then starts and stops locally at its scheduled times', async () => {
    const { controller, options } = setup()
    await controller.remember(record.payload, record.config)
    expect(options.save).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(9999)
    expect(options.activate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(options.activate).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(50_000)
    expect(options.stop).toHaveBeenCalledWith(record.payload.deploymentId)
    expect(options.save).toHaveBeenLastCalledWith([])
  })

  it('recovers a persisted downloaded schedule after application restart without a server', async () => {
    const first = setup()
    await first.controller.remember(record.payload, record.config)
    first.controller.dispose()
    vi.setSystemTime(new Date('2030-01-01T00:00:20Z'))
    const recovered = setup(first.disk())
    await recovered.controller.restore()
    await vi.advanceTimersByTimeAsync(1)
    expect(recovered.options.install).toHaveBeenCalledOnce()
    expect(recovered.options.activate).toHaveBeenCalledOnce()
    await recovered.controller.restore()
    expect(recovered.options.load).toHaveBeenCalledOnce()
  })

  it('skips a late start beyond the grace period', async () => {
    vi.setSystemTime(new Date('2030-01-01T00:00:45Z'))
    const { controller, options } = setup([record])
    await controller.restore()
    await vi.advanceTimersByTimeAsync(1)
    expect(options.activate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(options.stop).toHaveBeenCalledOnce()
  })

  it('does not execute expired, corrupted or foreign binding caches', async () => {
    const foreign = { ...record, binding: 'another-school' }
    const expired = {
      ...record,
      payload: {
        ...record.payload,
        automation: { ...record.payload.automation!, stopAt: '2029-01-01T00:00:00Z' }
      }
    }
    const { controller, options } = setup([foreign, expired, { binding, config: {} }])
    await controller.restore()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(options.install).not.toHaveBeenCalled()
    expect(options.activate).not.toHaveBeenCalled()
  })

  it('cancels a cached schedule and checks binding again before running it', async () => {
    const f = setup()
    await f.controller.remember(record.payload, record.config)
    await f.controller.forget(record.payload.deploymentId)
    await vi.advanceTimersByTimeAsync(11_000)
    expect(f.options.activate).not.toHaveBeenCalled()
    const g = setup()
    await g.controller.remember(record.payload, record.config)
    g.options.binding.mockReturnValue('another-school')
    await vi.advanceTimersByTimeAsync(1)
    expect(g.options.activate).not.toHaveBeenCalled()
  })

  it('reports a cache write failure instead of claiming an offline exam is prepared', async () => {
    const { controller, options } = setup()
    options.save.mockRejectedValueOnce(new Error('disk full'))
    await expect(controller.remember(record.payload, record.config)).rejects.toThrow('disk full')
    expect(options.error).toHaveBeenCalled()
    expect(options.activate).not.toHaveBeenCalled()
  })

  it('rejects a downloaded schedule when the binding changes during cache restore', async () => {
    const { controller, options } = setup()
    let finishLoad!: (value: unknown) => void
    options.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve
        })
    )
    const pending = controller.remember(record.payload, record.config)
    options.binding.mockReturnValue('another-school')
    finishLoad([])
    await expect(pending).rejects.toThrow('设备绑定已变化')
    expect(options.save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(options.activate).not.toHaveBeenCalled()
  })

  it('removes a cache saved while the device was being rebound', async () => {
    const { controller, options, disk } = setup()
    let finishSave!: () => void
    options.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = resolve
        })
    )
    const pending = controller.remember(record.payload, record.config)
    await vi.waitFor(() => expect(options.save).toHaveBeenCalledOnce())
    options.binding.mockReturnValue('another-school')
    finishSave()
    await expect(pending).rejects.toThrow('保存期间设备绑定发生变化')
    expect(disk()).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(options.activate).not.toHaveBeenCalled()
  })
})
