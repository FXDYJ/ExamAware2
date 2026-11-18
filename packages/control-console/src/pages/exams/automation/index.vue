<template>
  <div class="console-page">
    <PageHeader title="无人值守总览" description="集中查看执行计划、异常和考前检查结果。">
      <template #actions
        ><t-button variant="outline" :loading="loading" @click="load">刷新</t-button></template
      >
    </PageHeader>
    <t-card :bordered="false">
      <div class="console-toolbar">
        <t-space break-line>
          <t-select v-model="scope" :options="scopes" style="width: 160px" />
          <t-input v-model="search" placeholder="搜索考试名称" clearable />
        </t-space>
        <span class="console-muted"
          >待执行 {{ pendingCount }} · 执行中 {{ runningCount }} · 异常 {{ errorCount }}</span
        >
      </div>
      <t-alert v-if="error" theme="error" :message="error" />
      <t-table row-key="id" :data="filtered" :columns="columns" :loading="loading" hover>
        <template #name="{ row }"
          ><t-link theme="primary" @click="router.push(`/exams/${row.examConfigId}`)">{{
            row.name
          }}</t-link></template
        >
        <template #status="{ row }"
          ><t-tag
            :theme="row.lastError ? 'danger' : row.status === 'active' ? 'success' : 'default'"
            >{{ labels[row.status as keyof typeof labels] }}</t-tag
          ></template
        >
        <template #targets="{ row }">v{{ row.version }} · {{ row.deviceIds.length }} 台</template>
        <template #times="{ row }">
          <div>准备 {{ format(row.prepareAt) }}</div>
          <div>放映 {{ format(row.startAt) }}</div>
          <div>结束 {{ format(row.stopAt) }}</div>
        </template>
        <template #mode="{ row }"
          >{{ row.offlinePlayback ? '支持离线执行' : '服务器下发' }}
          <div class="console-muted">
            {{ row.lateJoinMinutes ? `迟到 ${row.lateJoinMinutes} 分钟截止` : '结束前补发' }}
          </div></template
        >
        <template #operation="{ row }"
          ><t-button variant="text" @click="check(row.examConfigId)">考前检查</t-button></template
        >
      </t-table>
    </t-card>
    <t-dialog v-model:visible="checking" header="考前检查" width="900px" :footer="false">
      <ExamPreflight v-if="report" :report="report" />
    </t-dialog>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { MessagePlugin, type PrimaryTableCol } from 'tdesign-vue-next';
import { examConfigsApi } from '@/api/control/exam-configs';
import type { ExamPreflightReport } from '@/api/control/types';
import PageHeader from '@/components/page-header/index.vue';
import ExamPreflight from '@/components/exam-automation/preflight.vue';
const router = useRouter();
const plans = ref<Awaited<ReturnType<typeof examConfigsApi.listAutomation>>>([]);
const loading = ref(false);
const error = ref('');
const search = ref('');
const scope = ref('pending');
const checking = ref(false);
const report = ref<ExamPreflightReport>();
const labels = {
  scheduled: '待执行',
  preparing: '准备中',
  active: '放映中',
  completed: '已结束',
  cancelled: '已取消'
};
const scopes = [
  { value: 'pending', label: '待执行与执行中' },
  { value: 'errors', label: '存在异常' },
  { value: 'all', label: '全部计划' }
];
const pendingCount = computed(
  () => plans.value.filter((plan) => plan.status === 'scheduled').length
);
const runningCount = computed(
  () => plans.value.filter((plan) => ['preparing', 'active'].includes(plan.status)).length
);
const errorCount = computed(() => plans.value.filter((plan) => plan.lastError).length);
const filtered = computed(() =>
  plans.value.filter(
    (plan) =>
      (!search.value || plan.name.includes(search.value)) &&
      (scope.value === 'all' ||
        (scope.value === 'errors'
          ? !!plan.lastError
          : ['scheduled', 'preparing', 'active'].includes(plan.status)))
  )
);
const columns: PrimaryTableCol[] = [
  { colKey: 'name', title: '考试' },
  { colKey: 'status', title: '状态', width: 100 },
  { colKey: 'targets', title: '固定范围', width: 120 },
  { colKey: 'times', title: '执行时间', width: 240 },
  { colKey: 'mode', title: '执行方式', width: 160 },
  { colKey: 'lastError', title: '最近异常' },
  { colKey: 'operation', title: '检查', width: 110 }
];
let timer: ReturnType<typeof setInterval> | undefined;
let disposed = false;
function format(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const response = await examConfigsApi.listAutomation();
    if (!disposed) {
      plans.value = response;
      error.value = '';
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '执行计划加载失败';
  } finally {
    loading.value = false;
  }
}
async function check(id: string) {
  try {
    report.value = await examConfigsApi.preflight(id);
    checking.value = true;
  } catch (e) {
    await MessagePlugin.error(e instanceof Error ? e.message : '考前检查失败');
  }
}
onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 5_000);
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
});
</script>
