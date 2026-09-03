import { IsBoolean, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Body of ABS `PATCH /api/me/progress/:libraryItemId`. Field names follow the ABS
 * MediaProgress payload. Unknown fields are rejected by the global ValidationPipe.
 */
export class UpdateAudiobookshelfProgressDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  currentTime?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  duration?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  progress?: number;

  @IsOptional()
  @IsBoolean()
  isFinished?: boolean;

  @IsOptional()
  @IsNumber()
  startedAt?: number;

  @IsOptional()
  @IsNumber()
  lastUpdate?: number;

  @IsOptional()
  @IsString()
  ebookLocation?: string | null;

  @IsOptional()
  @IsNumber()
  ebookProgress?: number | null;

  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  libraryItemId?: string;

  @IsOptional()
  @IsString()
  episodeId?: string;

  @IsOptional()
  @IsString()
  mediaItemType?: string;
}
