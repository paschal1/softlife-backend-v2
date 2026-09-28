import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { timingSafeEqual } from 'node:crypto';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../common/db/pg-errors';
import { isUuid, uuidv7 } from '../common/ids/uuidv7';
import { normalizePhone } from '../common/phone';
import { SYSTEM_DB } from '../database/database.tokens';
import type { DB } from '../database/database.types';
import { TenantDatabase } from '../database/tenant-database.service';
import { EventPublisher } from '../events/event-publisher.service';
import { EventTypes } from '../events/event-types';
import type { AuthContext, AuthTokens } from './auth.types';
import type { LoginDto, PinLoginDto, SignupDto } from './dto/auth.dto';
import { PasswordHasher } from './password-hasher.service';
import { PIN_LOCK_MINUTES, PinVerifier } from './pin-verifier.service';
import { hashRefreshSecret, SessionService } from './session.service';


@Injectable()
export class AuthService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    @Inject(SYSTEM_DB) private readonly systemDb: Kysely<DB>,
    private readonly passwords: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly events: EventPublisher,
    private readonly pins: PinVerifier,
  ) {}

  /** Creates the organization, its first branch and the owner account in one transaction. */
  async signup(dto: SignupDto): Promise<AuthTokens> {
    if (!dto.email && !dto.phone) {
      throw new BadRequestException('Provide an email address or phone number to sign in with');
    }

    const organizationId = uuidv7();
    const locationId = uuidv7();
    const userId = uuidv7();
    const email = dto.email?.trim().toLowerCase() ?? null;
    const phone = dto.phone ? normalizePhone(dto.phone) : null;
    const passwordHash = await this.passwords.hash(dto.password);
    const businessName = dto.businessName.trim();
    const locationName = dto.locationName?.trim() || 'Main Branch';
    const fullName = dto.fullName.trim();

    try {
      const tokens = await this.tenantDb.forOrganization(organizationId, async (trx) => {
        await trx.insertInto('organizations').values({ id: organizationId, name: businessName }).execute();
        await trx
          .insertInto('locations')
          .values({ id: locationId, organization_id: organizationId, name: locationName, address: null, phone: null })
          .execute();
        await trx
          .insertInto('users')
          .values({
            id: userId,
            organization_id: organizationId,
            full_name: fullName,
            email,
            phone,
            role: 'owner',
            password_hash: passwordHash,
            pin_hash: null,
            default_location_id: locationId,
          })
          .execute();

        const meta = { organizationId, actorId: userId, locationId };
        await this.events.record(trx, {
          ...meta,
          type: EventTypes.OrganizationCreated,
          aggregateType: 'organization',
          aggregateId: organizationId,
          payload: { after: { name: businessName } },
        });
        await this.events.record(trx, {
          ...meta,
          type: EventTypes.LocationCreated,
          aggregateType: 'location',
          aggregateId: locationId,
          payload: { after: { name: locationName } },
        });
        await this.events.record(trx, {
          ...meta,
          type: EventTypes.UserCreated,
          aggregateType: 'user',
          aggregateId: userId,
          payload: { after: { fullName, role: 'owner', email, phone } },
        });

        return this.sessions.issue(
          trx,
          { id: userId, organization_id: organizationId, full_name: fullName, role: 'owner', default_location_id: locationId },
          'password',
        );
      });
      return stripSessionId(tokens);
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        throw new ConflictException('An account with this email or phone number already exists');
      }
      throw err;
    }
  }

  /** Back-office login with email or phone + password. */
  async login(dto: LoginDto): Promise<AuthTokens> {
    const identifier = dto.identifier.trim();
    const byEmail = identifier.includes('@');

    // Pre-tenant lookup: the one legitimate use of the system connection in request handling.
    const user = await this.systemDb
      .selectFrom('users')
      .innerJoin('organizations', 'organizations.id', 'users.organization_id')
      .select([
        'users.id',
        'users.organization_id',
        'users.full_name',
        'users.role',
        'users.default_location_id',
        'users.password_hash',
      ])
      .where('users.is_active', '=', true)
      .where('users.password_hash', 'is not', null)
      .where('organizations.status', '=', 'active')
      .where((eb) =>
        byEmail
          ? eb(eb.fn<string>('lower', [eb.ref('users.email')]), '=', identifier.toLowerCase())
          : eb('users.phone', '=', normalizePhone(identifier)),
      )
      .executeTakeFirst();

    const valid = user?.password_hash
      ? await this.passwords.verify(user.password_hash, dto.password)
      : await this.passwords.verifyAgainstDummy(dto.password);
    if (!user || !valid) throw new UnauthorizedException('Incorrect email/phone or password');

    const tokens = await this.systemDb.transaction().execute(async (trx) => {
      await trx.updateTable('users').set({ last_login_at: sql`now()` }).where('id', '=', user.id).execute();
      return this.sessions.issue(trx, user, 'password');
    });
    return stripSessionId(tokens);
  }

  /**
   * Fast staff hand-off on a till that is already signed in to the organization.
   * The caller's token proves the device belongs to this organization; the PIN
   * proves which staff member is now at the register.
   */
  async pinLogin(device: AuthContext, dto: PinLoginDto): Promise<AuthTokens> {
    type Outcome = { ok: true; tokens: AuthTokens } | { ok: false; reason: 'invalid' | 'locked' };

    // Failed attempts must be COMMITTED before we reject, so the transaction returns
    // an outcome and the exception is thrown after it closes.
    const outcome = await this.tenantDb.forOrganization(device.organizationId, async (trx): Promise<Outcome> => {
      const check = await this.pins.check(trx, {
        organizationId: device.organizationId,
        userId: dto.userId,
        pin: dto.pin,
        attemptedBy: device.userId,
        locationId: device.locationId,
      });
      if (!check.ok) return check;

      await trx.updateTable('users').set({ last_login_at: sql`now()` }).where('id', '=', check.user.id).execute();
      return { ok: true, tokens: stripSessionId(await this.sessions.issue(trx, check.user, 'pin')) };
    });

    if (!outcome.ok) {
      throw new UnauthorizedException(
        outcome.reason === 'locked'
          ? `Too many wrong PIN attempts. Try again in ${PIN_LOCK_MINUTES} minutes or ask a manager to reset it.`
          : 'Incorrect PIN',
      );
    }
    return outcome.tokens;
  }

  /** Rotates a refresh token. Presenting an already-rotated token revokes the whole login. */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const [sessionId, secret] = refreshToken.split('.');
    if (!sessionId || !secret || !isUuid(sessionId)) throw new UnauthorizedException('Invalid refresh token');

    type Outcome = { ok: true; tokens: AuthTokens } | { ok: false; message: string };

    const outcome = await this.systemDb.transaction().execute(async (trx): Promise<Outcome> => {
      const session = await trx
        .selectFrom('auth_sessions')
        .selectAll()
        .where('id', '=', sessionId)
        .forUpdate()
        .executeTakeFirst();

      if (!session || !safeEqualHex(session.token_hash, hashRefreshSecret(secret))) {
        return { ok: false, message: 'Invalid refresh token' };
      }
      if (session.revoked_at) {
        // Reuse of a rotated token: someone else may hold this login. Kill every token in the family.
        await trx
          .updateTable('auth_sessions')
          .set({ revoked_at: sql`now()` })
          .where('family_id', '=', session.family_id)
          .where('revoked_at', 'is', null)
          .execute();
        return { ok: false, message: 'Session has been revoked. Please sign in again.' };
      }
      if (session.expires_at <= new Date()) return { ok: false, message: 'Session expired. Please sign in again.' };

      const user = await trx
        .selectFrom('users')
        .innerJoin('organizations', 'organizations.id', 'users.organization_id')
        .select(['users.id', 'users.organization_id', 'users.full_name', 'users.role', 'users.default_location_id'])
        .where('users.id', '=', session.user_id)
        .where('users.is_active', '=', true)
        .where('organizations.status', '=', 'active')
        .executeTakeFirst();
      if (!user) return { ok: false, message: 'Account is no longer active' };

      const tokens = await this.sessions.issue(trx, user, session.kind, session.family_id);
      await trx
        .updateTable('auth_sessions')
        .set({ revoked_at: sql`now()`, replaced_by: tokens.sessionId })
        .where('id', '=', session.id)
        .execute();
      return { ok: true, tokens: stripSessionId(tokens) };
    });

    if (!outcome.ok) throw new UnauthorizedException(outcome.message);
    return outcome.tokens;
  }

  /** Ends this login everywhere it was rotated to. Access tokens expire on their own (15 min). */
  async logout(auth: AuthContext): Promise<void> {
    await this.tenantDb.transaction(async (trx) => {
      const session = await trx
        .selectFrom('auth_sessions')
        .select('family_id')
        .where('id', '=', auth.sessionId)
        .executeTakeFirst();
      if (!session) return;
      await trx
        .updateTable('auth_sessions')
        .set({ revoked_at: sql`now()` })
        .where('family_id', '=', session.family_id)
        .where('revoked_at', 'is', null)
        .execute();
    });
  }

  async me(auth: AuthContext) {
    const user = await this.tenantDb.transaction((trx) =>
      trx
        .selectFrom('users')
        .select(['id', 'full_name', 'email', 'phone', 'role', 'default_location_id', 'organization_id'])
        .where('id', '=', auth.userId)
        .executeTakeFirst(),
    );
    if (!user) throw new NotFoundException();
    return {
      id: user.id,
      fullName: user.full_name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      organizationId: user.organization_id,
      defaultLocationId: user.default_location_id,
    };
  }
}

function stripSessionId(tokens: AuthTokens & { sessionId: string }): AuthTokens {
  const { sessionId: _sessionId, ...rest } = tokens;
  return rest;
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
