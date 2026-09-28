import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { isSupervisor } from '../common/roles';
import { TenantDatabase } from '../database/tenant-database.service';
import type { AuthContext } from './auth.types';
import { PIN_LOCK_MINUTES, PinVerifier } from './pin-verifier.service';

export interface ManagerApprovalInput {
  userId: string;
  pin: string;
}

/**
 * "Call a manager": an owner or manager enters their PIN on the cashier's till to approve
 * something the cashier can't do alone (going over a soft credit limit, giving a discount).
 * Runs in its own committed transaction so wrong PINs count toward that manager's lockout.
 */
@Injectable()
export class ManagerApproval {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly pins: PinVerifier,
  ) {}

  /** Returns the approver's user id. */
  async verify(auth: AuthContext, approval: ManagerApprovalInput): Promise<string> {
    const outcome = await this.tenantDb.forOrganization(auth.organizationId, async (trx) => {
      const approver = await trx.selectFrom('users').select('role').where('id', '=', approval.userId).executeTakeFirst();
      if (!approver || !isSupervisor(approver.role)) return { ok: false as const, reason: 'not_supervisor' as const };
      return this.pins.check(trx, {
        organizationId: auth.organizationId,
        userId: approval.userId,
        pin: approval.pin,
        attemptedBy: auth.userId,
        locationId: auth.locationId,
      });
    });

    if (outcome.ok) return outcome.user.id;
    if (outcome.reason === 'not_supervisor') throw new ForbiddenException('Approval must come from an owner or manager');
    throw new UnauthorizedException(
      outcome.reason === 'locked'
        ? `That manager PIN is locked for ${PIN_LOCK_MINUTES} minutes after too many wrong attempts`
        : 'Incorrect manager PIN',
    );
  }
}
