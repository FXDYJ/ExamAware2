import {
  MANAGED_SETTING_KEYS,
  PLAYER_STATUS,
  type BroadcastDismissCommand,
  type BroadcastShowCommand,
  type DeviceStateSnapshot,
  type ExamConfigPrepareCommand,
  type ManagedSetting,
  type PlaybackActivateCommand,
  type PlaybackStopCommand
} from '@dsz-examaware/control-protocol'
import { validateExamConfigDetailed, type ExamConfig } from '@dsz-examaware/core'
import { powerSaveBlocker } from 'electron'
import type {
  ControlProvider,
  ControlStatusSnapshot,
  ManagedSettingInput
} from '@dsz-examaware/plugin-sdk'
import { setConfig } from '../config/configStore'
import { playerSessionService } from '../player/playerSessionService'
import { applyTimeConfig, getCurrentTimeMs } from '../timeSync/timeService'
import type { ControlAgentEvent } from '../../shared/types/control'
import type { ControlApiClient } from './controlApiClient'
import type { ControlAgentService } from './controlAgentService'
import { ControlAgentError, type ControlRegistration } from './controlTypes'
import {
  clearManagedValues,
  loadManagedValues,
  saveManagedValues,
  startManagedConfigWatch
} from './managedControlStore'
import { clearEnrollmentMarker, writeEnrollmentMarker } from './controlEnrollmentMarker'
import { OfflinePlayback } from './offlinePlayback'
import { loadOfflineDeployments, saveOfflineDeployments } from './offlinePlaybackStore'
import { appLogger } from '../logging/logger'

interface PreparedDeployment {
  deploymentId: string
  examConfigId: string
  examConfigVersionId: string
  config: ExamConfig
}

type DevicePlayerState = NonNullable<DeviceStateSnapshot['player']>

export class ControlService {
  private readonly listeners = new Set<(event: ControlAgentEvent) => void>()
  private readonly preparedDeployments = new Map<string, PreparedDeployment>()
  private readonly stoppedDeployments = new Set<string>()
  private readonly controlSessionByDeployment = new Map<string, string>()
  private readonly activating = new Map<string, Promise<DeviceStateSnapshot>>()
  private wakeLock?: number
  private readonly offline = new OfflinePlayback({
    binding: () => this.bindingKey(),
    now: getCurrentTimeMs,
    load: loadOfflineDeployments,
    save: saveOfflineDeployments,
    install: (record) => {
      this.preparedDeployments.set(record.payload.deploymentId, {
        ...record.payload,
        config: record.config
      })
      if (this.playerState?.status !== PLAYER_STATUS.playing) {
        this.playerState = {
          status: PLAYER_STATUS.ready,
          deploymentId: record.payload.deploymentId,
          examConfigVersionId: record.payload.examConfigVersionId
        }
      }
    },
    activate: (record) => this.activateDeployment(record.payload),
    stop: (deploymentId) => this.stopDeployment({ deploymentId }),
    error: (error) => appLogger.error('[control] offline automation failed', error)
  })
  private readonly managedKeys = new Set<string>()
  private readonly managedValues = new Map<string, unknown>()
  private playerState?: DevicePlayerState
  private agent?: ControlAgentService
  private apiClient?: ControlApiClient
  private disposeAgentListener?: () => void
  private managedStateInitialized = false
  private disposeManagedConfigWatch?: () => void
  private disposeProviderListener?: () => void
  private provider?: { pluginName: string; value: ControlProvider }

  constructor() {
    playerSessionService.onChanged((event) => {
      const deploymentId = event.session.deploymentId
      if (event.session.origin !== 'control' || !deploymentId) return
      if (event.session.state !== 'closed' && event.session.state !== 'failed') return

      const prepared = this.preparedDeployments.get(deploymentId)
      this.controlSessionByDeployment.delete(deploymentId)
      if (this.controlSessionByDeployment.size === 0) this.releaseDisplay()
      if (event.session.state === 'closed') {
        this.preparedDeployments.delete(deploymentId)
        void this.offline
          .forget(deploymentId)
          .catch((error) => appLogger.error('[control] offline cache removal failed', error))
        this.playerState = {
          status: PLAYER_STATUS.idle,
          deploymentId,
          ...(prepared ? { examConfigVersionId: prepared.examConfigVersionId } : {})
        }
      } else {
        this.playerState = {
          status: PLAYER_STATUS.error,
          deploymentId,
          ...(prepared ? { examConfigVersionId: prepared.examConfigVersionId } : {}),
          errorCode: event.session.error?.code ?? 'player_session_failed'
        }
      }
      this.agent?.reportState()
    })
  }

  attach(agent: ControlAgentService, apiClient: ControlApiClient): void {
    this.disposeAgentListener?.()
    this.agent = agent
    this.apiClient = apiClient
    this.disposeAgentListener = agent.onChanged(() => {
      void this.offline
        .restore()
        .catch((error) => appLogger.error('[control] offline schedule restore failed', error))
      this.emitStatusChanged()
    })
  }

  async initializeManagedState(): Promise<void> {
    if (this.managedStateInitialized) return
    this.managedStateInitialized = true
    const values = await loadManagedValues()
    const allowedKeys = new Set<string>(Object.values(MANAGED_SETTING_KEYS))
    for (const [key, value] of Object.entries(values)) {
      if (!allowedKeys.has(key)) continue
      this.managedKeys.add(key)
      this.managedValues.set(key as ManagedSetting['key'], value as ManagedSetting['value'])
    }
    this.disposeManagedConfigWatch = startManagedConfigWatch((detail) =>
      this.reportManagedTamper(detail)
    )
    void this.emitStatusChanged()
  }

  async getStatus(): Promise<ControlStatusSnapshot> {
    if (this.provider) {
      const snapshot = await this.provider.value.getStatus()
      return this.withProviderMetadata(snapshot, 'plugin', this.provider.pluginName)
    }
    return this.getBuiltinStatus()
  }

  getBuiltinStatus(): ControlStatusSnapshot {
    if (!this.agent) {
      return { state: 'stopped', provider: 'builtin', managedSettingKeys: [...this.managedKeys] }
    }
    const snapshot = this.agent.getSnapshot()
    return {
      ...snapshot,
      provider: 'builtin',
      managedSettingKeys: [...this.managedKeys]
    }
  }

  onEvent(listener: (event: ControlAgentEvent) => void): () => void {
    this.listeners.add(listener)
    void this.emitStatusChanged()
    return () => this.listeners.delete(listener)
  }

  async bind(input: {
    serverUrl: string
    enrollmentCode: string
    displayName?: string
  }): Promise<ControlStatusSnapshot> {
    if (this.provider) {
      const snapshot = await this.provider.value.bind(input)
      await this.emitStatusChanged(snapshot)
      return this.withProviderMetadata(snapshot, 'plugin', this.provider.pluginName)
    }
    return this.bindBuiltin(input)
  }

  async unbind(): Promise<ControlStatusSnapshot> {
    if (this.provider) {
      const snapshot = await this.provider.value.unbind()
      await this.emitStatusChanged(snapshot)
      return this.withProviderMetadata(snapshot, 'plugin', this.provider.pluginName)
    }
    return this.unbindBuiltin()
  }

  async callProctor(
    input: { occurredAt: string } = { occurredAt: new Date().toISOString() }
  ): Promise<void> {
    if (this.managedValues.get(MANAGED_SETTING_KEYS.playerShowCallProctor) === false) {
      throw new ControlAgentError('proctor_call_disabled', '设备策略已关闭呼叫巡考')
    }
    if (this.provider) {
      await this.provider.value.callProctor(input)
      return
    }
    await this.requireAgent().callProctor(input)
  }

  registerProvider(pluginName: string, provider: ControlProvider): () => void {
    if (this.provider) {
      throw new ControlAgentError(
        'control_provider_conflict',
        `集控提供者已由插件 ${this.provider.pluginName} 接管`
      )
    }
    this.provider = { pluginName, value: provider }
    this.agent?.suspend()
    const providerListener = provider.onStatusChanged?.((snapshot) => {
      void this.emitStatusChanged(snapshot)
    })
    this.disposeProviderListener = providerListener
      ? () =>
          void Promise.resolve(
            typeof providerListener === 'function' ? providerListener() : providerListener.dispose()
          )
      : undefined
    void this.emitStatusChanged()
    return () => {
      if (this.provider?.pluginName !== pluginName || this.provider.value !== provider) return
      this.disposeProviderListener?.()
      this.disposeProviderListener = undefined
      this.provider = undefined
      void this.agent?.resume()
      void this.emitStatusChanged()
    }
  }

  useBuiltinProvider(pluginName: string): void {
    if (!this.provider) return
    if (this.provider.pluginName !== pluginName) {
      throw new ControlAgentError(
        'control_provider_not_owned',
        `当前集控提供者属于插件 ${this.provider.pluginName}`
      )
    }
    this.disposeProviderListener?.()
    this.disposeProviderListener = undefined
    this.provider = undefined
    void this.agent?.resume()
    void this.emitStatusChanged()
  }

  private async bindBuiltin(input: {
    serverUrl: string
    enrollmentCode: string
    displayName?: string
  }): Promise<ControlStatusSnapshot> {
    if (this.agent?.getRegistration() && this.isUnbindPrevented()) {
      throw new ControlAgentError('bind_blocked_by_policy', '集控策略禁止重新绑定或更换集控服务器')
    }
    await this.requireAgent().enroll(input.serverUrl, input.enrollmentCode, input.displayName)
    await this.offline.clear()
    this.preparedDeployments.clear()
    const registration = this.agent?.getRegistration()
    if (registration) void writeEnrollmentMarker(registration)
    return this.getBuiltinStatus()
  }

  private async unbindBuiltin(): Promise<ControlStatusSnapshot> {
    if (this.isUnbindPrevented()) {
      throw new ControlAgentError('unbind_blocked_by_policy', '集控策略禁止解绑本设备')
    }
    await this.requireAgent().clearEnrollment()
    await this.offline.clear()
    this.preparedDeployments.clear()
    this.managedKeys.clear()
    this.managedValues.clear()
    this.playerState = undefined
    void clearManagedValues()
    void this.emitStatusChanged()
    void clearEnrollmentMarker()
    return this.getBuiltinStatus()
  }

  getRegistration(): ControlRegistration | undefined {
    return this.agent?.getRegistration()
  }

  getDevicePlayerState(): DevicePlayerState | undefined {
    return this.playerState ? { ...this.playerState } : undefined
  }

  async prepareDeployment(
    payload: ExamConfigPrepareCommand['payload']
  ): Promise<DeviceStateSnapshot> {
    this.assertDeploymentNotStopped(payload.deploymentId)
    const registration = this.getRegistration()
    if (!registration) {
      throw new ControlAgentError('device_not_enrolled', '设备尚未接入集控服务器')
    }
    const artifact = await this.requireApiClient().downloadArtifact(
      registration,
      payload.artifact.url
    )
    if (artifact.bytes.byteLength !== payload.artifact.sizeBytes) {
      throw new ControlAgentError('artifact_size_mismatch', '集控考试档案大小校验失败')
    }
    if (artifact.sha256 !== payload.artifact.sha256) {
      throw new ControlAgentError('artifact_sha256_mismatch', '集控考试档案摘要校验失败')
    }

    let input: unknown
    try {
      input = JSON.parse(new TextDecoder().decode(artifact.bytes)) as unknown
    } catch (error) {
      throw new ControlAgentError(
        'artifact_invalid_json',
        '集控考试档案不是有效的 JSON',
        undefined,
        error
      )
    }
    const validation = validateExamConfigDetailed(input, { overlap: 'error', sort: true })
    if (!validation.valid || !validation.config) {
      throw new ControlAgentError('artifact_invalid_exam_config', '集控考试档案校验失败', {
        issues: validation.issues
      })
    }

    this.assertDeploymentNotStopped(payload.deploymentId)
    const current = this.getRegistration()
    if (
      current?.deviceId !== registration.deviceId ||
      current?.serverUrl !== registration.serverUrl
    ) {
      throw new ControlAgentError('device_binding_changed', '下载过程中设备绑定发生变化')
    }
    this.preparedDeployments.set(payload.deploymentId, {
      deploymentId: payload.deploymentId,
      examConfigId: payload.examConfigId,
      examConfigVersionId: payload.examConfigVersionId,
      config: validation.config
    })
    await this.offline.remember(
      payload,
      validation.config,
      `${registration.serverUrl}|${registration.deviceId}`
    )
    this.assertDeploymentNotStopped(payload.deploymentId)
    if (this.bindingKey() !== `${registration.serverUrl}|${registration.deviceId}`) {
      throw new ControlAgentError('device_binding_changed', '保存过程中设备绑定发生变化')
    }
    this.playerState = {
      status: PLAYER_STATUS.ready,
      deploymentId: payload.deploymentId,
      examConfigVersionId: payload.examConfigVersionId
    }
    return { player: { ...this.playerState } }
  }

  async activateDeployment(
    payload: PlaybackActivateCommand['payload']
  ): Promise<DeviceStateSnapshot> {
    const existing = this.activating.get(payload.deploymentId)
    if (existing) return existing
    const work = this.startDeployment(payload)
    this.activating.set(payload.deploymentId, work)
    try {
      return await work
    } finally {
      this.activating.delete(payload.deploymentId)
    }
  }

  private async startDeployment(
    payload: PlaybackActivateCommand['payload']
  ): Promise<DeviceStateSnapshot> {
    this.assertDeploymentNotStopped(payload.deploymentId)
    if (
      this.playerState?.status === PLAYER_STATUS.playing &&
      this.playerState.deploymentId === payload.deploymentId &&
      this.playerState.examConfigVersionId === payload.examConfigVersionId
    )
      return { player: { ...this.playerState } }
    const prepared = this.preparedDeployments.get(payload.deploymentId)
    if (!prepared) {
      throw new ControlAgentError('deployment_not_prepared', '集控考试尚未准备完成')
    }
    if (prepared.examConfigVersionId !== payload.examConfigVersionId) {
      throw new ControlAgentError('deployment_version_mismatch', '集控考试版本与已准备版本不一致')
    }
    const session = await playerSessionService.start(
      { kind: 'config', config: prepared.config },
      { replaceExisting: true, origin: 'control', deploymentId: payload.deploymentId },
      { allowUserExit: () => !this.isControlSessionExitPrevented() }
    )
    if (this.stoppedDeployments.has(payload.deploymentId)) {
      await playerSessionService.close(session.id)
      this.assertDeploymentNotStopped(payload.deploymentId)
    }
    this.controlSessionByDeployment.set(payload.deploymentId, session.id)
    if (this.wakeLock === undefined || !powerSaveBlocker.isStarted(this.wakeLock)) {
      this.wakeLock = powerSaveBlocker.start('prevent-display-sleep')
    }
    this.playerState = {
      status: PLAYER_STATUS.playing,
      deploymentId: payload.deploymentId,
      examConfigVersionId: payload.examConfigVersionId
    }
    return { player: { ...this.playerState } }
  }

  async stopDeployment(payload: PlaybackStopCommand['payload']): Promise<DeviceStateSnapshot> {
    this.stoppedDeployments.add(payload.deploymentId)
    if (this.stoppedDeployments.size > 1000) {
      this.stoppedDeployments.delete(this.stoppedDeployments.values().next().value!)
    }
    const prepared = this.preparedDeployments.get(payload.deploymentId)
    const sessionId = this.controlSessionByDeployment.get(payload.deploymentId)
    if (sessionId) await playerSessionService.close(sessionId)
    this.controlSessionByDeployment.delete(payload.deploymentId)
    if (this.controlSessionByDeployment.size === 0) this.releaseDisplay()
    this.preparedDeployments.delete(payload.deploymentId)
    await this.offline.forget(payload.deploymentId)
    this.playerState = {
      status: PLAYER_STATUS.idle,
      deploymentId: payload.deploymentId,
      ...(prepared ? { examConfigVersionId: prepared.examConfigVersionId } : {})
    }
    return { player: { ...this.playerState } }
  }

  private assertDeploymentNotStopped(deploymentId: string): void {
    if (this.stoppedDeployments.has(deploymentId)) {
      throw new ControlAgentError('deployment_stopped', '该集控考试已停止')
    }
  }

  private bindingKey() {
    const registration = this.getRegistration()
    return registration ? `${registration.serverUrl}|${registration.deviceId}` : undefined
  }

  private releaseDisplay() {
    if (this.wakeLock !== undefined) powerSaveBlocker.stop(this.wakeLock)
    this.wakeLock = undefined
  }

  emitBroadcast(payload: BroadcastShowCommand['payload']): void {
    this.emit({ type: 'broadcast', payload })
  }

  emitDismiss(payload: BroadcastDismissCommand['payload']): void {
    this.emit({ type: 'broadcast-dismiss', payload })
  }

  applyManagedSettings(settings: readonly ManagedSettingInput[], replace = false): void {
    if (replace) {
      this.managedKeys.clear()
      this.managedValues.clear()
    }
    for (const setting of settings) {
      const configKey = toDesktopConfigKey(setting.key)
      setConfig(configKey, setting.value)
      if (configKey.startsWith('time.')) {
        applyTimeConfig({ [configKey.slice(5)]: setting.value })
      }
      this.managedKeys.add(setting.key)
      this.managedValues.set(setting.key, setting.value)
    }
    void saveManagedValues(Object.fromEntries(this.managedValues))
    void this.emitStatusChanged()
  }

  clearManagedSettings(keys?: readonly string[]): void {
    const targets = keys?.length ? keys : [...this.managedKeys]
    for (const key of targets) {
      this.managedKeys.delete(key)
      this.managedValues.delete(key)
    }
    void saveManagedValues(Object.fromEntries(this.managedValues))
    void this.emitStatusChanged()
  }

  isManagedKey(key: string): boolean {
    return this.managedKeys.has(toProtocolSettingKey(key))
  }

  isControlSessionExitPrevented(): boolean {
    return this.managedValues.get(MANAGED_SETTING_KEYS.playerPreventControlSessionExit) === true
  }

  isUnbindPrevented(): boolean {
    return this.managedValues.get(MANAGED_SETTING_KEYS.controlPreventUnbind) === true
  }

  isQuitPrevented(): boolean {
    return this.managedValues.get(MANAGED_SETTING_KEYS.controlPreventQuit) === true
  }

  assertPluginInstallAllowed(pluginName?: string): void {
    if (this.managedValues.get(MANAGED_SETTING_KEYS.pluginPreventInstall) === true) {
      throw new Error('集控策略禁止安装插件')
    }
    if (!pluginName) return

    const normalizedName = pluginName.trim().toLowerCase()
    const blacklist = this.managedValues.get(MANAGED_SETTING_KEYS.pluginInstallBlacklist)
    if (pluginNameListIncludes(blacklist, normalizedName)) {
      throw new Error(`插件 ${pluginName} 已被集控策略列入安装黑名单`)
    }

    const allowlist = this.managedValues.get(MANAGED_SETTING_KEYS.pluginInstallAllowlist)
    if (
      Array.isArray(allowlist) &&
      allowlist.length > 0 &&
      !pluginNameListIncludes(allowlist, normalizedName)
    ) {
      throw new Error(`集控策略仅允许安装指定插件，${pluginName} 不在允许列表中`)
    }
  }

  reportManagedTamper(detail: string): void {
    if (!this.agent?.getRegistration()) return
    void this.agent
      .reportError({
        severity: 'warning',
        source: 'managed-settings',
        code: 'managed_settings_tamper_detected',
        message: detail,
        context: {},
        occurredAt: new Date().toISOString()
      })
      .catch(() => {})
  }

  protected emit(event: ControlAgentEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private async emitStatusChanged(
    snapshot?: Omit<ControlStatusSnapshot, 'provider' | 'providerPlugin'>
  ): Promise<void> {
    const resolved = snapshot
      ? this.withProviderMetadata(snapshot, 'plugin', this.provider?.pluginName)
      : await this.getStatus()
    this.emit({ type: 'state-changed', snapshot: resolved })
  }

  private withProviderMetadata(
    snapshot: Omit<ControlStatusSnapshot, 'provider' | 'providerPlugin'>,
    provider: ControlStatusSnapshot['provider'],
    providerPlugin?: string
  ): ControlStatusSnapshot {
    return {
      ...snapshot,
      provider,
      ...(providerPlugin ? { providerPlugin } : {}),
      managedSettingKeys: [...this.managedKeys]
    }
  }

  private requireAgent(): ControlAgentService {
    if (!this.agent) {
      throw new ControlAgentError('control_agent_unavailable', '集控服务尚未启动')
    }
    return this.agent
  }

  private requireApiClient(): ControlApiClient {
    if (!this.apiClient) {
      throw new ControlAgentError('control_agent_unavailable', '集控服务尚未启动')
    }
    return this.apiClient
  }
}

function pluginNameListIncludes(value: unknown, normalizedName: string): boolean {
  return (
    Array.isArray(value) &&
    value.some((item) => typeof item === 'string' && item.trim().toLowerCase() === normalizedName)
  )
}

function toDesktopConfigKey(key: string): string {
  return key.startsWith('timeSync.') ? `time.${key.slice('timeSync.'.length)}` : key
}

function toProtocolSettingKey(key: string): string {
  return key.startsWith('time.') ? `timeSync.${key.slice('time.'.length)}` : key
}

export const controlService = new ControlService()
