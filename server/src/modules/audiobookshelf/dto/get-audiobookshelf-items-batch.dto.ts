import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsString } from 'class-validator';

export class GetAudiobookshelfItemsBatchDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  libraryItemIds!: string[];
}
