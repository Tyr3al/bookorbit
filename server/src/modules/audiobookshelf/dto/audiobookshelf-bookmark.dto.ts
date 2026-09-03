import { IsNotEmpty, IsNumber, IsString, MaxLength, Min } from 'class-validator';

export class CreateAudiobookshelfBookmarkDto {
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  time!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title!: string;
}

export class UpdateAudiobookshelfBookmarkDto {
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  time!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title!: string;
}
