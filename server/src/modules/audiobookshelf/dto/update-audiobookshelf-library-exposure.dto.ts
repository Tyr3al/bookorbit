import { IsBoolean } from 'class-validator';

export class UpdateAudiobookshelfLibraryExposureDto {
  @IsBoolean()
  exposed: boolean;
}
