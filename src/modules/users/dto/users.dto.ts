import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { PHONE_PATTERN, PIN_PATTERN } from '../../../auth/dto/auth.dto';
import { ROLES, type Role } from '../../../database/database.types';

export class CreateUserDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  fullName!: string;

  @ApiProperty({ enum: ROLES })
  @IsIn(ROLES)
  role!: Role;

  @IsOptional() @IsEmail() @MaxLength(254)
  email?: string;

  @IsOptional() @Matches(PHONE_PATTERN, { message: 'phone must be a valid phone number' })
  phone?: string;

  /** Only for staff who need the back office. Till-only staff just get a PIN. */
  @IsOptional() @IsString() @MinLength(8) @MaxLength(128)
  password?: string;

  @IsOptional() @Matches(PIN_PATTERN, { message: 'pin must be 4 to 6 digits' })
  pin?: string;

  @IsOptional() @IsUUID()
  defaultLocationId?: string;
}

export class SetPinDto {
  @Matches(PIN_PATTERN, { message: 'pin must be 4 to 6 digits' })
  pin!: string;
}

export class UserDto {
  id!: string;
  fullName!: string;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({ enum: ROLES })
  role!: Role;

  @ApiProperty({ type: String, nullable: true })
  defaultLocationId!: string | null;

  isActive!: boolean;
  /** Can sign in to the back office. */
  hasPassword!: boolean;
  /** Can clock in at a till. */
  hasPin!: boolean;
  createdAt!: Date;
}
