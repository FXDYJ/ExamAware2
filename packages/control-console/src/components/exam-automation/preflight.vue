<template>
  <t-space direction="vertical" size="large" style="width: 100%">
    <t-alert
      :theme="report.ready === report.total ? 'success' : 'warning'"
      :message="`v${report.version} · ${report.ready}/${report.total} 台检查通过 · 检查于 ${new Date(report.checkedAt).toLocaleString('zh-CN')}`"
    />
    <t-table row-key="id" :data="report.devices" :columns="columns">
      <template #online="{ row }"
        ><t-tag :theme="row.online ? 'success' : 'warning'">{{
          row.online ? '在线' : '离线'
        }}</t-tag></template
      >
      <template #time="{ row }">{{
        row.timeSync?.synchronized ? `${Math.round(row.timeSync.offsetMs ?? 0)} ms` : '未确认同步'
      }}</template>
      <template #issues="{ row }">{{ row.issues.join('；') || '检查通过' }}</template>
    </t-table>
  </t-space>
</template>
<script setup lang="ts">
import type { PrimaryTableCol } from 'tdesign-vue-next';
import type { ExamPreflightReport } from '@/api/control/types';
defineProps<{ report: ExamPreflightReport }>();
const columns: PrimaryTableCol[] = [
  { colKey: 'displayName', title: '设备' },
  { colKey: 'online', title: '连接', width: 90 },
  { colKey: 'appVersion', title: '客户端', width: 100 },
  { colKey: 'time', title: '时钟偏差', width: 120 },
  { colKey: 'issues', title: '检查结果' }
];
</script>
