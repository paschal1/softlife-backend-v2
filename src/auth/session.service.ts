import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Kysely } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { uuidv7 } from '../common/ids/uuidv7';
import type { Env } from '../config/env';
import type { DB, Role } from '../database/database.types';
import type { AccessTokenClaims, AuthTokens } from './auth.types';

export interface SessionUser {
  id: string;
  organization_id: string;
  full_name: string;
  role: Role;
  default_location_id: string | null;
}

export type SessionKind = 'password' | 'pin';

export function hashRefreshSecret(secret: string): string {
  // Refresh secrets are 256 bits of randomness, so a fast hash is appropriate here
  // (argon2 exists to slow down guessing low-entropy human secrets).
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Issues an access token + rotating refresh token.
 * Refresh token format: "<sessionId>.<secret>". Only the secret's hash is stored.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** `db` must be a connection allowed to write this organization's auth_sessions. */
  async issue(db: Kysely<DB>, user: SessionUser, kind: SessionKind, familyId?: string): Promise<AuthTokens & { sessionId: string }> {
    const sessionId = uuidv7();
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.refreshTtlMs(kind));

    await db
      .insertInto('auth_sessions')
      .values({
        id: sessionId,
        organization_id: user.organization_id,
        user_id: user.id,
        family_id: familyId ?? sessionId,
        kind,
        token_hash: hashRefreshSecret(secret),
        expires_at: expiresAt,
      })
      .execute();

    const claims: AccessTokenClaims = {
      sub: user.id,
      org: user.organization_id,
      role: user.role,
      loc: user.default_location_id,
      sid: sessionId,
    };
    const accessTokenExpiresIn = this.config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });

    return {
      sessionId,
      accessToken: await this.jwt.signAsync(claims, { expiresIn: accessTokenExpiresIn }),
      accessTokenExpiresIn,
      refreshToken: `${sessionId}.${secret}`,
      refreshTokenExpiresAt: expiresAt.toISOString(),
      user: {
        id: user.id,
        fullName: user.full_name,
        role: user.role,
        organizationId: user.organization_id,
        defaultLocationId: user.default_location_id,
      },
    };
  }

  private refreshTtlMs(kind: SessionKind): number {
    // PIN sessions are shift-length: a till left logged in overnight shouldn't stay usable for a month.
    return kind === 'pin'
      ? this.config.get('PIN_SESSION_TTL_HOURS', { infer: true }) * 3_600_000
      : this.config.get('REFRESH_TTL_DAYS', { infer: true }) * 86_400_000;
  }
}
