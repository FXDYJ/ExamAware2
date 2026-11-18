import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { ExamConfigsModule } from '../exam-configs/exam-configs.module.js';
import { PartitionsModule } from '../partitions/partitions.module.js';
import { ControlCommandsController } from './control-commands.controller.js';
import {
  BroadcastsController,
  ExamDeploymentsController,
  ManagedSettingsController
} from './control-operations.controller.js';
import { ControlOperationsService } from './control-operations.service.js';
import { DeviceArtifactsController } from './device-artifacts.controller.js';
import { ControlCommandsRepository } from './control-commands.repository.js';
import { ControlCommandsService } from './control-commands.service.js';
import { ExamAutomationRepository } from './exam-automation.repository.js';
import { ExamAutomationService } from './exam-automation.service.js';
import {
  ExamAutomationController,
  ExamAutomationOverviewController
} from './exam-automation.controller.js';

@Module({
  imports: [AuditModule, DevicesModule, ExamConfigsModule, PartitionsModule],
  controllers: [
    ExamAutomationController,
    ExamAutomationOverviewController,
    ControlCommandsController,
    ExamDeploymentsController,
    BroadcastsController,
    ManagedSettingsController,
    DeviceArtifactsController
  ],
  providers: [
    ControlCommandsRepository,
    ControlCommandsService,
    ControlOperationsService,
    ExamAutomationRepository,
    ExamAutomationService
  ],
  exports: [ControlCommandsRepository, ControlCommandsService, ControlOperationsService]
})
export class ControlCommandsModule {}
