import { ApiProperty } from '@nestjs/swagger';
import { ROLES, type Role } from '../../database/database.types';

export class AuthUserDto {
  id!: string;
  fullName!: string;

  @ApiProperty({ enum: ROLES })
  role!: Role;

  organizationId!: string;

  @ApiProperty({ type: String, nullable: true })
  defaultLocationId!: string | null;
}

export class AuthTokensDto {
  /** Send as `Authorization: Bearer <accessToken>`. */
  accessToken!: string;
  /** Seconds until the access token expires. */
  accessTokenExpiresIn!: number;
  /** Exchange at /auth/refresh before it expires. Store securely; it rotates on every use. */
  refreshToken!: string;
  refreshTokenExpiresAt!: string;
  user!: AuthUserDto;
}

export class MeDto {
  id!: string;
  fullName!: string;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({ enum: ROLES })
  role!: Role;

  organizationId!: string;

  @ApiProperty({ type: String, nullable: true })
  defaultLocationId!: string | null;
}
