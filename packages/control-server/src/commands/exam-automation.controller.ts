import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import { API_VERSION } from '../api/application.js';
import { RequestId, RequestOrigin } from '../api/request-context.js';
import type { AuthenticatedSession } from '../auth/auth.types.js';
import { SaveExamAutomationDto } from './dto/exam-automation.dto.js';
import { ExamAutomationService } from './exam-automation.service.js';

@ApiTags('exam-automation')
@ApiCookieAuth('better-auth.session_token')
@Controller({ path: 'exam-configs/:examConfigId/automation', version: API_VERSION })
export class ExamAutomationController {
  constructor(@Inject(ExamAutomationService) private readonly service: ExamAutomationService) {}

  @Get()
  @Roles(['admin', 'operator', 'viewer'])
  async get(@Param('examConfigId', ParseUUIDPipe) id: string) {
    return { plan: await this.service.get(id) };
  }

  @Put()
  @Roles(['admin', 'operator'])
  @ApiOperation({
    summary: 'Schedule unattended preparation, playback and stop on a target snapshot'
  })
  save(
    @Param('examConfigId', ParseUUIDPipe) id: string,
    @Body() input: SaveExamAutomationDto,
    @Session() session: AuthenticatedSession,
    @RequestId() requestId: string,
    @RequestOrigin() publicOrigin: string
  ) {
    return this.service.save(id, input, { actorUserId: session.user.id, requestId, publicOrigin });
  }

  @Get('preflight')
  @Roles(['admin', 'operator', 'viewer'])
  preflight(@Param('examConfigId', ParseUUIDPipe) id: string) {
    return this.service.preflight(id);
  }

  @Delete()
  @Roles(['admin', 'operator'])
  async cancel(
    @Param('examConfigId', ParseUUIDPipe) id: string,
    @Session() session: AuthenticatedSession,
    @RequestId() requestId: string
  ) {
    return { plan: await this.service.cancel(id, { actorUserId: session.user.id, requestId }) };
  }
}

@ApiTags('exam-automation')
@ApiCookieAuth('better-auth.session_token')
@Controller({ path: 'exam-automation', version: API_VERSION })
export class ExamAutomationOverviewController {
  constructor(@Inject(ExamAutomationService) private readonly service: ExamAutomationService) {}

  @Get()
  @Roles(['admin', 'operator', 'viewer'])
  list() {
    return this.service.list();
  }
}
