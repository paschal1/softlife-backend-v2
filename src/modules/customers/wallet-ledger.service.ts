import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Transaction } from 'kysely';
import { pgErrorCode } from '../../common/db/pg-errors';
import type { DB, MoneyInMethod, WalletTransactionType } from '../../database/database.types';

const PG_CHECK_VIOLATION = '23514';

export interface WalletEntry {
  /** Client-generated UUIDv7 where available: it is the idempotency key. */
  id: string;
  organizationId: string;
  customerId: string;
  type: WalletTransactionType;
  /** Signed: negative for payments. */
  amountKobo: number;
  actorId: string | null;
  method?: MoneyInMethod | null;
  reference?: string | null;
  reason?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  registerSessionId?: string | null;
}

/**
 * The ONLY way any module changes a wallet balance. Call it inside your own transaction.
 * The database trigger applies it to the balance, and the balance's CHECK refuses to go
 * below zero, which surfaces here as a clear "insufficient balance" error.
 */
@Injectable()
export class WalletLedger {
  async exists(trx: Transaction<DB>, id: string): Promise<boolean> {
    return (await trx.selectFrom('wallet_transactions').select('id').where('id', '=', id).executeTakeFirst()) !== undefined;
  }

  async record(trx: Transaction<DB>, entry: WalletEntry): Promise<{ balanceAfterKobo: number }> {
    const customer = await trx
      .selectFrom('customers')
      .select(['id', 'is_active'])
      .where('id', '=', entry.customerId)
      .executeTakeFirst();
    if (!customer) throw new NotFoundException('Customer not found');
    if (!customer.is_active && entry.type !== 'refund') throw new BadRequestException('This customer has been deactivated');

    if (entry.amountKobo < 0) {
      const available = await this.balance(trx, entry.customerId);
      if (available + entry.amountKobo < 0) {
        throw new BadRequestException(
          `Insufficient wallet balance: ${available} kobo available, ${Math.abs(entry.amountKobo)} kobo requested`,
        );
      }
    }

    try {
      await trx
        .insertInto('wallet_transactions')
        .values({
          id: entry.id,
          organization_id: entry.organizationId,
          customer_id: entry.customerId,
          type: entry.type,
          amount_kobo: entry.amountKobo,
          method: entry.method ?? null,
          reference: entry.reference?.trim() || null,
          reason: entry.reason?.trim() || null,
          reference_type: entry.referenceType ?? null,
          reference_id: entry.referenceId ?? null,
          register_session_id: entry.registerSessionId ?? null,
          created_by: entry.actorId,
        })
        .execute();
    } catch (err) {
      // Another till spent from this wallet between our check and our insert. The database
      // refused to overdraw it; the transaction is now aborted, so report without querying.
      if (pgErrorCode(err) === PG_CHECK_VIOLATION && isBalanceCheck(err)) {
        throw new BadRequestException('Insufficient wallet balance: the balance changed just now. Please try again.');
      }
      throw err;
    }

    return { balanceAfterKobo: await this.balance(trx, entry.customerId) };
  }

  async balance(trx: Transaction<DB>, customerId: string): Promise<number> {
    const wallet = await trx
      .selectFrom('customer_wallets')
      .select('balance_kobo')
      .where('customer_id', '=', customerId)
      .executeTakeFirst();
    return wallet?.balance_kobo ?? 0;
  }
}

function isBalanceCheck(err: unknown): boolean {
  const e = err as { table?: string; constraint?: string };
  return e.table === 'customer_wallets' || (e.constraint ?? '').startsWith('customer_wallets');
}
