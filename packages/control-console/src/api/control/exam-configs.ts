import type { ExamConfig } from '@dsz-examaware/core';
import { apiRequest } from '../http';
import type {
  ExamConfigDetail,
  ExamAutomation,
  ExamPreflightReport,
  ExamConfigSummary,
  ExamConfigVersion,
  PageResponse,
  PublicExamLinkResponse
} from './types';

const EXAM_CONFIGS_PATH = '/api/v1/exam-configs';

export const examConfigsApi = {
  listAutomation() {
    return apiRequest<
      (Omit<ExamAutomation, 'preparedCount' | 'startedCount' | 'failedCount'> & { name: string })[]
    >('/api/v1/exam-automation');
  },
  preflight(id: string) {
    return apiRequest<ExamPreflightReport>(
      `${EXAM_CONFIGS_PATH}/${encodeURIComponent(id)}/automation/preflight`
    );
  },
  async getAutomation(id: string) {
    const response = await apiRequest<{ plan: ExamAutomation | null }>(
      `${EXAM_CONFIGS_PATH}/${encodeURIComponent(id)}/automation`
    );
    return response.plan;
  },
  saveAutomation(
    id: string,
    input: {
      prepareAt: string;
      startAt: string;
      stopAt: string;
      offlinePlayback?: boolean;
      lateJoinMinutes?: number;
    }
  ) {
    return apiRequest<ExamAutomation>(`${EXAM_CONFIGS_PATH}/${encodeURIComponent(id)}/automation`, {
      method: 'PUT',
      body: JSON.stringify(input)
    });
  },
  async cancelAutomation(id: string) {
    const response = await apiRequest<{ plan: ExamAutomation | null }>(
      `${EXAM_CONFIGS_PATH}/${encodeURIComponent(id)}/automation`,
      { method: 'DELETE' }
    );
    return response.plan;
  },
  list(page = 1, pageSize = 20) {
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    return apiRequest<PageResponse<ExamConfigSummary>>(`${EXAM_CONFIGS_PATH}?${query}`);
  },
  get(id: string) {
    return apiRequest<ExamConfigDetail>(`${EXAM_CONFIGS_PATH}/${encodeURIComponent(id)}`);
  },
  createPublicLink(id: string, version?: number, expiresInSeconds = 3600) {
    return apiRequest<PublicExamLinkResponse>(
      `${EXAM_CONFIGS_PATH}/${encodeURIComponent(id)}/public-link`,
      {
        method: 'POST',
        body: JSON.stringify({ version, expiresInSeconds })
      }
    );
  },
  create(name: string, content: ExamConfig) {
    return apiRequest<ExamConfigDetail>(EXAM_CONFIGS_PATH, {
      method: 'POST',
      body: JSON.stringify({ name, content })
    });
  },
  importEa2(name: string, file: File) {
    const form = new FormData();
    form.set('name', name);
    form.set('file', file);
    return apiRequest<ExamConfigDetail>(`${EXAM_CONFIGS_PATH}/import`, {
      method: 'POST',
      body: form
    });
  },
  createVersion(id: string, content: ExamConfig) {
    return apiRequest<ExamConfigVersion>(
      `${EXAM_CONFIGS_PATH}/${encodeURIComponent(id)}/versions`,
      { method: 'POST', body: JSON.stringify({ content }) }
    );
  },
  importVersion(id: string, file: File) {
    const form = new FormData();
    form.set('file', file);
    return apiRequest<ExamConfigVersion>(
      `${EXAM_CONFIGS_PATH}/${encodeURIComponent(id)}/versions/import`,
      { method: 'POST', body: form }
    );
  },
  update(
    id: string,
    patch: Partial<
      Pick<ExamConfigSummary, 'name' | 'assignedDeviceIds' | 'assignedPartitionNodeIds'>
    >
  ) {
    return apiRequest<ExamConfigDetail>(`${EXAM_CONFIGS_PATH}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    });
  },
  remove(id: string) {
    return apiRequest<void>(`${EXAM_CONFIGS_PATH}/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
  }
};
