import { IsEmail, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export const PIN_PATTERN = /^\d{4,6}$/;
export const PHONE_PATTERN = /^\+?[\d\s-]{10,17}$/;

export class SignupDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  businessName!: string;

  @IsString() @IsNotEmpty() @MaxLength(120)
  fullName!: string;

  @IsOptional() @IsEmail() @MaxLength(254)
  email?: string;

  @IsOptional() @Matches(PHONE_PATTERN, { message: 'phone must be a valid phone number' })
  phone?: string;

  @IsString() @MinLength(8) @MaxLength(128)
  password!: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120)
  locationName?: string;
}

export class LoginDto {
  /** Email address or phone number. */
  @IsString() @IsNotEmpty() @MaxLength(254)
  identifier!: string;

  @IsString() @IsNotEmpty() @MaxLength(128)
  password!: string;
}

export class RefreshDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  refreshToken!: string;
}

export class PinLoginDto {
  @IsUUID()
  userId!: string;

  @Matches(PIN_PATTERN, { message: 'pin must be 4 to 6 digits' })
  pin!: string;
}
