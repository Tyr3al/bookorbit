import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsString } from 'class-validator';

export class GetAbsItemsBatchDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  libraryItemIds!: string[];
}
