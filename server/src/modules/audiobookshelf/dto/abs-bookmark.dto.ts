import { IsNotEmpty, IsNumber, IsString, MaxLength, Min } from 'class-validator';

export class CreateAbsBookmarkDto {
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  time!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title!: string;
}

export class UpdateAbsBookmarkDto {
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  time!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title!: string;
}
