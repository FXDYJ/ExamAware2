<template>
  <t-card title="无人值守" :bordered="false">
    <template #actions>
      <t-space v-if="canWrite">
        <t-button v-if="!running" variant="outline" @click="openEditor">{{
          active ? '修改计划' : '设置执行计划'
        }}</t-button>
        <t-popconfirm v-if="active" content="取消计划会停止本次放映，确认取消？" @confirm="cancel">
          <t-button theme="danger" variant="outline" :loading="saving">取消计划并停止</t-button>
        </t-popconfirm>
      </t-space>
    </template>
    <t-alert v-if="loadError" theme="error" :message="loadError" />
    <t-descriptions v-if="plan" :column="3" bordered>
      <t-descriptions-item label="状态">{{ statusLabels[plan.status] }}</t-descriptions-item>
      <t-descriptions-item label="固定配置"
        >v{{ plan.version }} · {{ plan.deviceIds.length }} 台设备</t-descriptions-item
      >
      <t-descriptions-item label="执行结果"
        >已准备 {{ plan.preparedCount }} · 已开始 {{ plan.startedCount }} · 失败
        {{ plan.failedCount }}</t-descriptions-item
      >
      <t-descriptions-item label="自动准备">{{
        formatDateTime(plan.prepareAt)
      }}</t-descriptions-item>
      <t-descriptions-item label="自动开始放映">{{
        formatDateTime(plan.startAt)
      }}</t-descriptions-item>
      <t-descriptions-item label="自动结束放映">{{
        formatDateTime(plan.stopAt)
      }}</t-descriptions-item>
    </t-descriptions>
    <p v-else-if="!loadError" class="console-muted">
      预先设置准备、放映和结束时间，保存后由服务器自动执行，后台可以关闭。
    </p>
    <t-alert v-if="plan?.lastError" theme="error" :message="plan.lastError" />
    <p v-if="active" class="console-muted">
      客户端需保持运行。结束前上线的设备会自动补发，下载失败会重试。巡考按钮可在「设备策略」关闭。
    </p>
  </t-card>
  <t-dialog v-model:visible="editing" header="无人值守执行计划" width="640px" :footer="false">
    <t-form :data="form" layout="vertical" @submit="save">
      <t-alert
        theme="info"
        :message="`时间按浏览器时区 ${timeZone}。计划固定使用当前 v${exam.latestVersion} 和已分配的目标设备。`"
      />
      <t-form-item label="自动准备时间">
        <input
          v-model="form.prepareAt"
          type="datetime-local"
          aria-label="自动准备时间"
          step="1"
          required
          class="automation-time"
        />
      </t-form-item>
      <t-form-item label="自动开始放映时间">
        <input
          v-model="form.startAt"
          type="datetime-local"
          aria-label="自动开始放映时间"
          step="1"
          required
          class="automation-time"
        />
      </t-form-item>
      <t-form-item label="自动结束放映时间">
        <input
          v-model="form.stopAt"
          type="datetime-local"
          aria-label="自动结束放映时间"
          step="1"
          required
          class="automation-time"
        />
      </t-form-item>
      <p class="console-muted">开始放映后，各科目的倒计时和提醒仍按档案中的时间执行。</p>
      <t-space>
        <t-button type="submit" :loading="saving">保存执行计划</t-button>
        <t-button variant="outline" @click="editing = false">取消</t-button>
      </t-space>
    </t-form>
  </t-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { examConfigsApi } from '@/api/control/exam-configs';
import type { ExamAutomation, ExamConfigDetail } from '@/api/control/types';

const props = defineProps<{ exam: ExamConfigDetail; canWrite: boolean }>();
const emit = defineEmits<{ changed: [active: boolean] }>();
const plan = ref<ExamAutomation | null>(null);
const editing = ref(false);
const saving = ref(false);
const loadError = ref('');
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const active = computed(
  () => !!plan.value && ['scheduled', 'preparing', 'active'].includes(plan.value.status)
);
const running = computed(() => !!plan.value && ['preparing', 'active'].includes(plan.value.status));
const statusLabels = {
  scheduled: '等待定时执行',
  preparing: '自动准备中',
  active: '自动放映中',
  completed: '已结束',
  cancelled: '已取消'
};
const form = reactive({ prepareAt: '', startAt: '', stopAt: '' });
let timer: ReturnType<typeof setInterval> | undefined;
let refreshing = false;
let disposed = false;

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function localTime(value: number | string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function openEditor() {
  const infos = props.exam.latest.content.examInfos;
  const first = Math.min(...infos.map((info) => new Date(info.start).getTime()));
  const last = Math.max(...infos.map((info) => new Date(info.end).getTime()));
  const startAt = Math.max(Date.now() + 10 * 60_000, first - 10 * 60_000);
  form.prepareAt = localTime(active.value ? plan.value!.prepareAt : startAt - 5 * 60_000);
  form.startAt = localTime(active.value ? plan.value!.startAt : startAt);
  form.stopAt = localTime(
    active.value ? plan.value!.stopAt : Math.max(startAt + 60 * 60_000, last + 5 * 60_000)
  );
  editing.value = true;
}

async function refresh() {
  if (refreshing || disposed) return;
  refreshing = true;
  try {
    const response = await examConfigsApi.getAutomation(props.exam.id);
    if (disposed) return;
    plan.value = response;
    loadError.value = '';
    emit('changed', active.value);
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '执行计划加载失败';
  } finally {
    refreshing = false;
  }
}

async function save() {
  if (saving.value) return;
  const times = Object.fromEntries(
    Object.entries(form).map(([key, value]) => [key, new Date(value).getTime()])
  );
  if (
    !Object.values(times).every(Number.isFinite) ||
    times.startAt <= Date.now() ||
    times.prepareAt > times.startAt ||
    times.startAt >= times.stopAt
  ) {
    await MessagePlugin.error('请按准备、开始、结束顺序填写时间，开始时间须晚于当前时间');
    return;
  }
  saving.value = true;
  try {
    plan.value = await examConfigsApi.saveAutomation(props.exam.id, {
      prepareAt: new Date(times.prepareAt).toISOString(),
      startAt: new Date(times.startAt).toISOString(),
      stopAt: new Date(times.stopAt).toISOString()
    });
    emit('changed', active.value);
    editing.value = false;
    await MessagePlugin.success('执行计划已保存，服务器将自动执行');
  } catch (error) {
    await MessagePlugin.error(error instanceof Error ? error.message : '计划保存失败');
  } finally {
    saving.value = false;
  }
}

async function cancel() {
  if (saving.value) return;
  saving.value = true;
  try {
    plan.value = await examConfigsApi.cancelAutomation(props.exam.id);
    emit('changed', active.value);
    await MessagePlugin.success('计划已取消，停止命令已下发');
  } catch (error) {
    await MessagePlugin.error(error instanceof Error ? error.message : '取消失败');
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void refresh();
  timer = setInterval(() => void refresh(), 2_000);
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
});
</script>

<style scoped>
.automation-time {
  width: 100%;
  padding: 8px 12px;
  color: var(--td-text-color-primary);
  background: var(--td-bg-color-container);
  border: 1px solid var(--td-border-level-2-color);
  border-radius: var(--td-radius-default);
  font: inherit;
}
</style>
