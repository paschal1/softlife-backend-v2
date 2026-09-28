import { Injectable } from '@nestjs/common';
import { sql, Transaction } from 'kysely';
import type { DB, Role } from '../database/database.types';
import { EventPublisher } from '../events/event-publisher.service';
import { EventTypes } from '../events/event-types';
import { PasswordHasher } from './password-hasher.service';

export const MAX_PIN_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 15;

export interface PinUser {
  id: string;
  organization_id: string;
  full_name: string;
  role: Role;
  default_location_id: string | null;
}

export type PinCheck = { ok: true; user: PinUser } | { ok: false; reason: 'invalid' | 'locked' };

/**
 * Verifies a staff PIN with brute-force protection: 5 wrong attempts lock that PIN for
 * 15 minutes, whether the guessing happens at PIN login or at a manager-approval prompt.
 *
 * IMPORTANT: run check() in a transaction that COMMITS even when the result is not ok,
 * then throw afterwards. Otherwise the failed-attempt counter rolls back with the error.
 */
@Injectable()
export class PinVerifier {
  constructor(
    private readonly passwords: PasswordHasher,
    private readonly events: EventPublisher,
  ) {}

  async check(
    trx: Transaction<DB>,
    input: { organizationId: string; userId: string; pin: string; attemptedBy: string; locationId: string | null },
  ): Promise<PinCheck> {
    const user = await trx
      .selectFrom('users')
      .select(['id', 'organization_id', 'full_name', 'role', 'default_location_id', 'pin_hash', 'pin_failed_attempts', 'pin_locked_until'])
      .where('id', '=', input.userId)
      .where('is_active', '=', true)
      .forUpdate()
      .executeTakeFirst();

    if (!user?.pin_hash) {
      await this.passwords.verifyAgainstDummy(input.pin);
      return { ok: false, reason: 'invalid' };
    }
    if (user.pin_locked_until && user.pin_locked_until > new Date()) return { ok: false, reason: 'locked' };

    if (!(await this.passwords.verify(user.pin_hash, input.pin))) {
      const attempts = user.pin_failed_attempts + 1;
      const locked = attempts >= MAX_PIN_ATTEMPTS;
      await trx
        .updateTable('users')
        .set({
          pin_failed_attempts: locked ? 0 : attempts,
          pin_locked_until: locked ? sql`now() + make_interval(mins => ${PIN_LOCK_MINUTES})` : null,
        })
        .where('id', '=', user.id)
        .execute();
      if (locked) {
        await this.events.record(trx, {
          organizationId: input.organizationId,
          actorId: input.attemptedBy,
          locationId: input.locationId,
          type: EventTypes.UserPinLocked,
          aggregateType: 'user',
          aggregateId: user.id,
          payload: { lockedForMinutes: PIN_LOCK_MINUTES },
        });
      }
      return { ok: false, reason: locked ? 'locked' : 'invalid' };
    }

    if (user.pin_failed_attempts > 0 || user.pin_locked_until) {
      await trx.updateTable('users').set({ pin_failed_attempts: 0, pin_locked_until: null }).where('id', '=', user.id).execute();
    }
    return {
      ok: true,
      user: {
        id: user.id,
        organization_id: user.organization_id,
        full_name: user.full_name,
        role: user.role,
        default_location_id: user.default_location_id,
      },
    };
  }
}
