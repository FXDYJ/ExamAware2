import { validateExamConfigDetailed, type ExamConfig } from '@dsz-examaware/core'
import {
  examConfigPreparePayloadSchema,
  type ExamConfigPrepareCommand
} from '@dsz-examaware/control-protocol'

export interface OfflineDeployment {
  binding: string
  payload: ExamConfigPrepareCommand['payload']
  config: ExamConfig
}

interface OfflinePlaybackOptions {
  binding(): string | undefined
  load(): Promise<unknown>
  save(records: OfflineDeployment[]): Promise<void>
  install(record: OfflineDeployment): void
  activate(record: OfflineDeployment): Promise<unknown>
  stop(deploymentId: string): Promise<unknown>
  error(error: unknown): void
  now?(): number
}

const MAX_TIMEOUT_MS = 30_000

/** Executes only downloaded, validated schedules belonging to the current binding. */
export class OfflinePlayback {
  private readonly records = new Map<string, OfflineDeployment>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly started = new Set<string>()
  private readonly running = new Set<string>()
  private restoredBinding?: string
  private restoring?: Promise<void>
  private writing = Promise.resolve()

  constructor(private readonly options: OfflinePlaybackOptions) {}

  async restore(): Promise<void> {
    if (this.restoring) return this.restoring
    const binding = this.options.binding()
    if (!binding || binding === this.restoredBinding) return
    this.restoring = this.load(binding).finally(() => {
      this.restoring = undefined
    })
    return this.restoring
  }

  private async load(binding: string) {
    const input = await this.options.load()
    if (this.options.binding() !== binding) return
    this.dispose()
    this.records.clear()
    for (const item of Array.isArray(input) ? input : []) {
      if (!item || item.binding !== binding) continue
      const payload = examConfigPreparePayloadSchema.safeParse(item.payload)
      const config = validateExamConfigDetailed(item.config, { overlap: 'error', sort: true })
      if (
        !payload.success ||
        !payload.data.automation ||
        !config.valid ||
        !config.config ||
        Date.parse(payload.data.automation.stopAt) <= this.now() ||
        Date.parse(payload.data.automation.stopAt) > Date.parse(payload.data.artifact.expiresAt)
      )
        continue
      const record = { binding, payload: payload.data, config: config.config }
      this.records.set(record.payload.deploymentId, record)
      this.options.install(record)
    }
    this.restoredBinding = binding
    for (const id of this.records.keys()) this.arm(id, 0)
  }

  async remember(
    payload: ExamConfigPrepareCommand['payload'],
    config: ExamConfig,
    expectedBinding = this.options.binding()
  ) {
    if (!payload.automation) return
    await this.restore()
    const binding = this.options.binding()
    if (!binding || binding !== expectedBinding) throw new Error('设备绑定已变化，无法保存离线计划')
    if (Date.parse(payload.automation.stopAt) > Date.parse(payload.artifact.expiresAt)) {
      throw new Error('离线计划超过档案授权有效期')
    }
    this.records.set(payload.deploymentId, { binding, payload, config })
    await this.persist()
    if (this.options.binding() !== binding) {
      await this.forget(payload.deploymentId)
      throw new Error('保存期间设备绑定发生变化')
    }
    this.arm(payload.deploymentId, 0)
  }

  async forget(id: string) {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    this.started.delete(id)
    if (this.records.delete(id)) await this.persist()
  }

  async clear() {
    this.dispose()
    this.records.clear()
    this.started.clear()
    this.restoredBinding = undefined
    await this.persist()
  }

  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private persist() {
    const snapshot = [...this.records.values()]
    const result = this.writing.then(() => this.options.save(snapshot))
    this.writing = result.catch((error) => this.options.error(error))
    return result
  }

  private arm(id: string, delay: number) {
    if (!this.records.has(id)) return
    clearTimeout(this.timers.get(id))
    const timer = setTimeout(
      () => void this.execute(id),
      Math.min(MAX_TIMEOUT_MS, Math.max(0, delay))
    )
    timer.unref?.()
    this.timers.set(id, timer)
  }

  private async execute(id: string) {
    const record = this.records.get(id)
    if (!record || this.running.has(id)) return
    if (record.binding !== this.options.binding()) {
      await this.forget(id).catch(this.options.error)
      return
    }
    const window = record.payload.automation!
    const now = this.now()
    if (now < Date.parse(window.startAt)) {
      this.arm(id, Date.parse(window.startAt) - now)
      return
    }
    this.running.add(id)
    try {
      if (now >= Date.parse(window.stopAt)) {
        await this.options.stop(id)
        await this.forget(id)
        return
      }
      if (!this.started.has(id) && now < Date.parse(window.latestStartAt)) {
        await this.options.activate(record)
        this.started.add(id)
      }
      this.arm(id, Date.parse(window.stopAt) - this.now())
    } catch (error) {
      this.options.error(error)
      this.arm(id, 15_000)
    } finally {
      this.running.delete(id)
    }
  }

  private now() {
    return this.options.now?.() ?? Date.now()
  }
}
