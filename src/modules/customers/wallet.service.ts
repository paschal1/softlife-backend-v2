import { Injectable, NotFoundException } from '@nestjs/common';
import { sql, Transaction } from 'kysely';
import type { AuthContext } from '../../auth/auth.types';
import { uuidv7 } from '../../common/ids/uuidv7';
import { decodeCursor, encodeCursor } from '../../common/pagination';
import type { DB } from '../../database/database.types';
import { TenantDatabase } from '../../database/tenant-database.service';
import { EventPublisher } from '../../events/event-publisher.service';
import { EventTypes } from '../../events/event-types';
import { RegisterSessionsService } from '../registers/register-sessions.service';
import type {
  AdjustWalletDto,
  TopUpWalletDto,
  WalletOperationResultDto,
  WalletTransactionDto,
  WalletTransactionPageDto,
  WalletTransactionsQueryDto,
} from './dto/wallet.dto';
import { WalletLedger } from './wallet-ledger.service';

type Trx = Transaction<DB>;

@Injectable()
export class WalletService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly ledger: WalletLedger,
    private readonly registers: RegisterSessionsService,
    private readonly events: EventPublisher,
  ) {}

  /** WAL-01. Staff-initiated for MVP (Decision Q3). */
  async topUp(auth: AuthContext, customerId: string, dto: TopUpWalletDto): Promise<WalletOperationResultDto> {
    return this.tenantDb.transaction(async (trx) => {
      if (dto.id && (await this.ledger.exists(trx, dto.id))) return this.result(trx, customerId, dto.id, true);
      const id = dto.id ?? uuidv7();

      // Cash physically goes into a till, so it must show up in that till's EOD expected cash.
      const till =
        dto.method === 'cash'
          ? await this.registers.recordCashInOpenSession(trx, auth, {
              kind: 'wallet_top_up',
              amountKobo: dto.amountKobo,
              referenceType: 'wallet_transaction',
              referenceId: id,
              action: 'taking cash',
            })
          : null;

      const { balanceAfterKobo } = await this.ledger.record(trx, {
        id,
        organizationId: auth.organizationId,
        customerId,
        type: 'top_up',
        amountKobo: dto.amountKobo,
        actorId: auth.userId,
        method: dto.method,
        reference: dto.reference ?? null,
        registerSessionId: till?.sessionId ?? null,
      });

      await this.events.record(trx, {
        type: EventTypes.WalletToppedUp,
        aggregateType: 'customer',
        aggregateId: customerId,
        payload: {
          transactionId: id,
          amountKobo: dto.amountKobo,
          method: dto.method,
          reference: dto.reference?.trim() || null,
          registerSessionId: till?.sessionId ?? null,
          after: { balanceKobo: balanceAfterKobo },
        },
      });

      return this.result(trx, customerId, id, false);
    });
  }

  /** Owner-only correction, always with a reason. */
  async adjust(auth: AuthContext, customerId: string, dto: AdjustWalletDto): Promise<WalletOperationResultDto> {
    return this.tenantDb.transaction(async (trx) => {
      if (dto.id && (await this.ledger.exists(trx, dto.id))) return this.result(trx, customerId, dto.id, true);
      const id = dto.id ?? uuidv7();
      const before = await this.ledger.balance(trx, customerId);

      const { balanceAfterKobo } = await this.ledger.record(trx, {
        id,
        organizationId: auth.organizationId,
        customerId,
        type: 'adjustment',
        amountKobo: dto.amountKobo,
        actorId: auth.userId,
        reason: dto.reason,
      });

      await this.events.record(trx, {
        type: EventTypes.WalletAdjusted,
        aggregateType: 'customer',
        aggregateId: customerId,
        payload: {
          transactionId: id,
          amountKobo: dto.amountKobo,
          reason: dto.reason.trim(),
          before: { balanceKobo: before },
          after: { balanceKobo: balanceAfterKobo },
        },
      });

      return this.result(trx, customerId, id, false);
    });
  }

  /** WAL-03: newest first, each line carrying the balance right after it. */
  async transactions(customerId: string, query: WalletTransactionsQueryDto): Promise<WalletTransactionPageDto> {
    const limit = query.limit ?? 50;
    const cursor = query.cursor ? decodeCursor(query.cursor, 2) : null;

    return this.tenantDb.transaction(async (trx) => {
      const customer = await trx.selectFrom('customers').select('id').where('id', '=', customerId).executeTakeFirst();
      if (!customer) throw new NotFoundException('Customer not found');

      // Rows older than the cursor are all kept, so the running sum stays exact on every page.
      const rows = await this.historyQuery(trx, customerId)
        .$if(cursor !== null, (qb) =>
          qb.where(sql<boolean>`(w.created_at, w.id) < (${new Date(cursor![0]!)}, ${cursor![1]!})`),
        )
        .orderBy('w.created_at', 'desc')
        .orderBy('w.id', 'desc')
        .limit(limit + 1)
        .execute();

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        balanceKobo: await this.ledger.balance(trx, customerId),
        items: page.map(toDto),
        nextCursor: rows.length > limit && last ? encodeCursor([last.created_at.toISOString(), last.id]) : null,
      };
    });
  }

  private historyQuery(trx: Trx, customerId: string) {
    return trx
      .selectFrom('wallet_transactions as w')
      .leftJoin('users as u', 'u.id', 'w.created_by')
      .selectAll('w')
      .select([
        'u.full_name as created_by_name',
        sql<number>`(sum(w.amount_kobo) over (order by w.created_at, w.id))::bigint`.as('balance_after'),
      ])
      .where('w.customer_id', '=', customerId);
  }

  private async result(trx: Trx, customerId: string, transactionId: string, replayed: boolean): Promise<WalletOperationResultDto> {
    const row = await trx
      .selectFrom(this.historyQuery(trx, customerId).as('t'))
      .selectAll()
      .where('t.id', '=', transactionId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Wallet transaction not found for this customer');
    return { transaction: toDto(row), balanceKobo: await this.ledger.balance(trx, customerId), replayed };
  }
}

function toDto(r: {
  id: string;
  customer_id: string;
  type: WalletTransactionDto['type'];
  amount_kobo: number;
  balance_after: number;
  method: WalletTransactionDto['method'];
  reference: string | null;
  reason: string | null;
  reference_type: string | null;
  reference_id: string | null;
  register_session_id: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
}): WalletTransactionDto {
  return {
    id: r.id,
    customerId: r.customer_id,
    type: r.type,
    amountKobo: r.amount_kobo,
    balanceAfterKobo: Number(r.balance_after),
    method: r.method,
    reference: r.reference,
    reason: r.reason,
    referenceType: r.reference_type,
    referenceId: r.reference_id,
    registerSessionId: r.register_session_id,
    createdById: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
  };
}
