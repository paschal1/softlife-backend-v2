import type { Request } from 'express';
import type { Role } from '../database/database.types';

/** Claims inside the short-lived access JWT. */
export interface AccessTokenClaims {
  sub: string; // user id
  org: string; // organization id
  role: Role;
  loc: string | null; // default location id
  sid: string; // auth session id
}

/** The verified caller, attached to the request by JwtAuthGuard. */
export interface AuthContext {
  userId: string;
  organizationId: string;
  role: Role;
  locationId: string | null;
  sessionId: string;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

export interface AuthUserView {
  id: string;
  fullName: string;
  role: Role;
  organizationId: string;
  defaultLocationId: string | null;
}

export interface AuthTokens {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: AuthUserView;
}
