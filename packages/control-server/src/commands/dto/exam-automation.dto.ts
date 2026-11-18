import { IsISO8601 } from 'class-validator';

export class SaveExamAutomationDto {
  @IsISO8601({ strict: true })
  prepareAt!: string;

  @IsISO8601({ strict: true })
  startAt!: string;

  @IsISO8601({ strict: true })
  stopAt!: string;
}
