import { IsString, IsOptional, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ChatMessageDto {
  @ApiProperty()
  @IsString()
  role: string;

  @ApiProperty()
  @IsString()
  content: string;
}

export class ChatRequestDto {
  @ApiProperty()
  @IsString()
  message: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  history?: ChatMessageDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  context?: string;
}
