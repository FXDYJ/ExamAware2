import { IsBoolean, IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

export class SaveExamAutomationDto {
  @IsISO8601({ strict: true })
  prepareAt!: string;

  @IsISO8601({ strict: true })
  startAt!: string;

  @IsISO8601({ strict: true })
  stopAt!: string;

  @IsOptional()
  @IsBoolean()
  offlinePlayback = false;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  lateJoinMinutes = 0;
}
