import { IsEmail, IsString, MinLength, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @MinLength(6)
  password!: string;
}

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @MinLength(6)
  password!: string;

  @ApiProperty({ required: false, example: 'John Doe' })
  @IsOptional()
  @IsString()
  fullName?: string;

  @ApiProperty({ required: false, example: 'ABC123DEF4' })
  @IsOptional()
  @IsString()
  invite_code?: string;
}

export class RefreshTokenDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  refresh_token?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  refreshToken?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  token?: string;
}

export class SendVerificationCodeDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;
}

export class VerifyEmailDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  verification_code!: string;

  @ApiProperty({ required: false, example: 'password123' })
  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  @ApiProperty({ required: false, example: 'ABC123DEF4' })
  @IsOptional()
  @IsString()
  invite_code?: string;
}

export class LoginSmsDto {
  @ApiProperty({ example: '13800138000' })
  @IsString()
  phone!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  code!: string;

  @ApiProperty({ required: false, example: 'ABC123DEF4' })
  @IsOptional()
  @IsString()
  invite_code?: string;
}

export class LoginEmailCodeDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  code!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  verification_code!: string;

  @ApiProperty({ example: 'newpassword123' })
  @IsString()
  @MinLength(6)
  new_password!: string;
}
