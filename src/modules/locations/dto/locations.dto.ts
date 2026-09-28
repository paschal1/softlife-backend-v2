import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PHONE_PATTERN } from '../../../auth/dto/auth.dto';

export class CreateLocationDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name!: string;

  @IsOptional() @IsString() @MaxLength(500)
  address?: string;

  @IsOptional() @Matches(PHONE_PATTERN, { message: 'phone must be a valid phone number' })
  phone?: string;
}

export class LocationDto {
  id!: string;
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  address!: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  isActive!: boolean;
  createdAt!: Date;
}
