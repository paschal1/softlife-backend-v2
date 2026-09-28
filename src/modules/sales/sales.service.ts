import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, Transaction } from 'kysely';
import type { AuthContext } from '../../auth/auth.types';
import { ManagerApproval } from '../../auth/manager-approval.service';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../common/db/pg-errors';
import { uuidv7 } from '../../common/ids/uuidv7';
import { decodeCursor, encodeCursor } from '../../common/pagination';
import { isSupervisor } from '../../common/roles';
import type { DB } from '../../database/database.types';
import { TenantDatabase } from '../../database/tenant-database.service';
import { EventPublisher } from '../../events/event-publisher.service';
import { EventTypes } from '../../events/event-types';
import { WalletLedger } from '../customers/wallet-ledger.service';
import { DeliveryQueue } from '../deliveries/delivery-queue.service';
import { StockLedger } from '../inventory/stock-ledger.service';
import { RegisterSessionsService } from '../registers/register-sessions.service';
import type { CreateSaleDto, ListSalesQueryDto, ManualRefundDto, SaleDto, SalePageDto, VoidSaleDto, VoidSaleResultDto } from './dto/sales.dto';
import { decideCredit, planPayments, PricedProduct, priceSale, PricingError } from './pricing';

type Trx = Transaction<DB>;

/** Online sales may be a little late; offline sales can arrive days later from a till without signal. */
const MAX_BACKDATE_MS = 72 * 3_600_000;
const MAX_OFFLINE_BACKDATE_MS = 30 * 86_400_000;

/**
 * Offline sales already happened: the customer left with the goods. Instead of refusing what
 * no longer fits (a changed price, a wallet spent elsewhere, a limit exceeded, a discount
 * approved at the till), the server records the sale as it happened and adds a flag for the
 * owner to review. `flags` is filled in by create().
 */
export interface OfflineSaleOptions {
  /** The session the till recorded the sale in: it must be the cashier's open session. */
  registerSessionId: string;
  /** Manager who approved at the till (PIN checked locally). Honoured only if they are an owner/manager. */
  approvedById: string | null;
  flags: string[];
}

export interface SaleCreateOptions {
  offline?: OfflineSaleOptions;
}
const MAX_CLOCK_SKEW_MS = 5 * 60_000;


@Injectable()
export class SalesService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly registers: RegisterSessionsService,
    private readonly stock: StockLedger,
    private readonly wallets: WalletLedger,
    private readonly managerApproval: ManagerApproval,
    private readonly events: EventPublisher,
    private readonly deliveries: DeliveryQueue,
  ) {}

  async create(auth: AuthContext, dto: CreateSaleDto, options: SaleCreateOptions = {}): Promise<SaleDto> {
    const offline = options.offline;
    const needsFulfilment = dto.orderType === 'delivery' || dto.orderType === 'pre_order';
    const fulfilment = needsFulfilment ? (dto.orderType === 'delivery' ? 'delivery' : (dto.delivery?.fulfilment ?? 'delivery')) : null;
    if (dto.orderType === 'delivery' && dto.delivery?.fulfilment === 'pickup') {
      throw new BadRequestException('A delivery order is delivered. For a customer who will collect, use a pre-order with fulfilment "pickup".');
    }
    if (needsFulfilment && !dto.delivery) throw new BadRequestException('Delivery orders and pre-orders need a date (and an address unless picked up)');
    if (!needsFulfilment && dto.payments.some((p) => p.method === 'pay_on_delivery')) {
      throw new BadRequestException('Pay on delivery is only for delivery orders and pre-orders');
    }
    const occurredAt = resolveOccurredAt(dto.occurredAt, offline ? MAX_OFFLINE_BACKDATE_MS : MAX_BACKDATE_MS);

    // Verified in its own committed transaction so wrong PINs count toward the lockout.
    // (Offline sales carry a manager claim instead; see below.)
    const approverId = !offline && dto.managerApproval ? await this.managerApproval.verify(auth, dto.managerApproval) : null;

    try {
      return await this.tenantDb.transaction(async (trx) => {
        if (dto.id) {
          const existing = await trx.selectFrom('sales').select('id').where('id', '=', dto.id).executeTakeFirst();
          if (existing) return this.detail(trx, auth, existing.id);
        }
        const saleId = dto.id ?? uuidv7();

        const org = await trx
          .selectFrom('organizations')
          .select(['enabled_order_types', 'credit_limit_mode', 'default_credit_limit_kobo'])
          .executeTakeFirstOrThrow();
        if (!org.enabled_order_types.includes(dto.orderType)) {
          throw new BadRequestException(`${dto.orderType} orders are not enabled for this business`);
        }

        // REG-02: no sale without the cashier's own open register session.
        const session = await this.registers.requireOpenSession(trx, auth.userId);
        if (offline && session.id !== offline.registerSessionId) {
          throw new HttpException(
            {
              statusCode: HttpStatus.CONFLICT,
              error: 'SESSION_MISMATCH',
              message: 'This sale was recorded in a register session that is no longer the cashier\'s open session.',
            },
            HttpStatus.CONFLICT,
          );
        }

        // ── Customer ──────────────────────────────────────────────────────────
        const usesCustomerMoney = dto.payments.some((p) => p.method === 'wallet' || p.method === 'credit');
        if ((dto.orderType === 'credit' || usesCustomerMoney) && !dto.customerId) {
          throw new BadRequestException('Attach a customer for credit orders and for wallet or credit payments');
        }
        const customer = dto.customerId
          ? await trx
              .selectFrom('customers')
              .select(['id', 'name', 'is_active', 'credit_limit_kobo'])
              .where('id', '=', dto.customerId)
              .forUpdate() // serializes credit checks for this customer across tills
              .executeTakeFirst()
          : undefined;
        if (dto.customerId && !customer) throw new NotFoundException('Customer not found');
        if (customer && !customer.is_active) throw new BadRequestException('This customer has been deactivated');

        // ── Delivery ──────────────────────────────────────────────────────────
        if (dto.delivery?.driverId) {
          const driver = await trx
            .selectFrom('users')
            .select('id')
            .where('id', '=', dto.delivery.driverId)
            .where('is_active', '=', true)
            .executeTakeFirst();
          if (!driver) throw new BadRequestException('Unknown driver');
        }

        // ── Price (server-side, always from current product prices) ──────────
        const productIds = [...new Set(dto.items.map((i) => i.productId))];
        const productRows = await trx
          .selectFrom('products')
          .select(['id', 'name', 'unit', 'selling_price_kobo', 'wholesale_price_kobo', 'tracks_stock', 'is_active'])
          .where('id', 'in', productIds)
          .execute();
        const inactive = productRows.find((p) => !p.is_active);
        if (inactive) throw new BadRequestException(`${inactive.name} is no longer sold`);
        const catalog = new Map<string, PricedProduct>(
          productRows.map((p) => [
            p.id,
            { id: p.id, name: p.name, unit: p.unit, sellingPriceKobo: p.selling_price_kobo, wholesalePriceKobo: p.wholesale_price_kobo },
          ]),
        );
        const lines = dto.items.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
          discountKobo: i.discountKobo,
          unitPriceKobo: offline ? (i as { unitPriceKobo?: number }).unitPriceKobo : undefined,
        }));
        const priced = priceSale(lines, catalog, dto.orderType);
        const priceMismatches = priced.lines
          .filter((l) => l.unitPriceKobo !== l.catalogPriceKobo)
          .map((l) => ({ productId: l.productId, chargedKobo: l.unitPriceKobo, catalogKobo: l.catalogPriceKobo }));
        if (offline && priceMismatches.length > 0) offline.flags.push('price_differs_from_catalogue');

        // Offline: the wallet may have been spent on another till meanwhile. Charge what is
        // there and move the rest to the customer's debt rather than undoing a finished sale.
        let payments = [...dto.payments];
        const walletPayment = payments.find((p) => p.method === 'wallet');
        if (offline && customer && walletPayment) {
          const available = await this.wallets.balance(trx, customer.id);
          if (available < walletPayment.amountKobo) {
            const shortfall = walletPayment.amountKobo - available;
            payments = payments.filter((p) => p !== walletPayment);
            if (available > 0) payments.push({ ...walletPayment, amountKobo: available });
            const credit = payments.find((p) => p.method === 'credit');
            payments = credit
              ? payments.map((p) => (p === credit ? { ...p, amountKobo: p.amountKobo + shortfall } : p))
              : [...payments, { method: 'credit' as const, amountKobo: shortfall }];
            offline.flags.push('wallet_shortfall_moved_to_credit');
          }
        }
        const plan = planPayments(priced.totalKobo, payments);

        // ── Approvals: discounts and soft credit-limit overrides ───────────────
        const approvalReasons: string[] = [];
        let creditDetail: { limitKobo: number; projectedKobo: number } | null = null;

        if (priced.discountKobo > 0 && !isSupervisor(auth.role)) approvalReasons.push('discount');

        if (plan.creditKobo > 0 && customer) {
          const outstanding = await this.outstandingDebt(trx, customer.id);
          const decision = decideCredit(
            outstanding,
            plan.creditKobo,
            customer.credit_limit_kobo ?? org.default_credit_limit_kobo,
            org.credit_limit_mode,
          );
          if (decision.outcome === 'blocked' && offline) {
            creditDetail = { limitKobo: decision.limitKobo, projectedKobo: decision.projectedKobo };
            offline.flags.push('credit_limit_exceeded');
          } else if (decision.outcome === 'blocked') {
            throw new HttpException(
              {
                statusCode: HttpStatus.CONFLICT,
                error: 'CREDIT_LIMIT_EXCEEDED',
                message: `${customer.name} would owe ${decision.projectedKobo} kobo, over their ${decision.limitKobo} kobo limit`,
                limitKobo: decision.limitKobo,
                projectedKobo: decision.projectedKobo,
                outstandingKobo: outstanding,
              },
              HttpStatus.CONFLICT,
            );
          }
          if (decision.outcome === 'needs_approval') {
            creditDetail = { limitKobo: decision.limitKobo, projectedKobo: decision.projectedKobo };
            if (!isSupervisor(auth.role)) approvalReasons.push('credit_limit');
          }
        }

        // Offline: the manager approved at the till. Honour the claim only if they really are one.
        let offlineApprover: string | null = null;
        if (offline?.approvedById) {
          const claimed = await trx.selectFrom('users').select('role').where('id', '=', offline.approvedById).executeTakeFirst();
          if (claimed && isSupervisor(claimed.role)) offlineApprover = offline.approvedById;
        }
        if (offline && !offlineApprover) {
          for (const reason of approvalReasons) offline.flags.push(`unapproved_${reason}`);
        }

        if (!offline && approvalReasons.length > 0 && !approverId) {
          throw new HttpException(
            {
              statusCode: HttpStatus.CONFLICT,
              error: 'MANAGER_APPROVAL_REQUIRED',
              message: 'A manager must approve this sale. Ask them to enter their PIN, then resubmit with managerApproval.',
              reasons: approvalReasons,
              ...(creditDetail ?? {}),
            },
            HttpStatus.CONFLICT,
          );
        }
        const approvedBy =
          approvalReasons.length > 0 ? (offline ? offlineApprover : approverId) : creditDetail ? auth.userId : null;
        const recordedReasons = approvalReasons.length > 0 ? approvalReasons : creditDetail ? ['credit_limit'] : [];

        // ── Record the sale ───────────────────────────────────────────────────
        const number = await this.nextNumber(trx, auth.organizationId, 'sale');
        await trx
          .insertInto('sales')
          .values({
            id: saleId,
            organization_id: auth.organizationId,
            number,
            location_id: session.location_id,
            register_id: session.register_id,
            register_session_id: session.id,
            cashier_id: auth.userId,
            customer_id: customer?.id ?? null,
            order_type: dto.orderType,
            subtotal_kobo: priced.subtotalKobo,
            discount_kobo: priced.discountKobo,
            total_kobo: priced.totalKobo,
            paid_kobo: plan.paidKobo,
            credit_kobo: plan.creditKobo,
            change_kobo: plan.changeKobo,
            cod_kobo: plan.codKobo,
            fulfilment,
            delivery_address: fulfilment === 'delivery' ? (dto.delivery?.address?.trim() ?? null) : null,
            delivery_date: dto.delivery?.date ?? null,
            delivery_driver_id: fulfilment === 'delivery' ? (dto.delivery?.driverId ?? null) : null,
            note: dto.note?.trim() || null,
            approved_by: approvedBy,
            approval_reasons: recordedReasons.length > 0 ? recordedReasons : null,
            occurred_at: occurredAt,
          })
          .execute();

        await trx
          .insertInto('sale_items')
          .values(
            priced.lines.map((l) => ({
              id: uuidv7(),
              organization_id: auth.organizationId,
              sale_id: saleId,
              line_no: l.lineNo,
              product_id: l.productId,
              product_name: l.productName,
              unit: l.unit,
              quantity: l.quantity,
              unit_price_kobo: l.unitPriceKobo,
              discount_kobo: l.discountKobo,
              line_total_kobo: l.lineTotalKobo,
            })),
          )
          .execute();

        // POS-04: stock leaves the shelf in the same transaction as the sale.
        const tracked = new Set(productRows.filter((p) => p.tracks_stock).map((p) => p.id));
        const stockLines = priced.lines.filter((l) => tracked.has(l.productId));
        if (stockLines.length > 0) {
          await this.stock.record(
            trx,
            stockLines.map((l) => ({
              productId: l.productId,
              locationId: session.location_id,
              type: 'sale' as const,
              quantityDelta: -l.quantity,
              referenceType: 'sale',
              referenceId: saleId,
            })),
            { organizationId: auth.organizationId, actorId: auth.userId, batchId: saleId, allowNegative: true },
          );
        }

        // DEBT-01: the credit portion becomes a debt on the customer's account.
        const debtId = plan.creditKobo > 0 ? uuidv7() : null;
        if (debtId && customer) {
          await trx
            .insertInto('debt_records')
            .values({ id: debtId, organization_id: auth.organizationId, customer_id: customer.id, sale_id: saleId, amount_kobo: plan.creditKobo })
            .execute();
        }

        // WAL-02: the wallet portion leaves the wallet (the database refuses to overdraw it).
        const walletTxnId = plan.walletKobo > 0 ? uuidv7() : null;
        let walletBalanceAfter: number | null = null;
        if (walletTxnId && customer) {
          walletBalanceAfter = (
            await this.wallets.record(trx, {
              id: walletTxnId,
              organizationId: auth.organizationId,
              customerId: customer.id,
              type: 'payment',
              amountKobo: -plan.walletKobo,
              actorId: auth.userId,
              referenceType: 'sale',
              referenceId: saleId,
            })
          ).balanceAfterKobo;
        }

        // Cash goes into the till, so EOD expects it.
        if (plan.cashKobo > 0) {
          await this.registers.recordCashInOpenSession(trx, auth, {
            kind: 'cash_sale',
            amountKobo: plan.cashKobo,
            referenceType: 'sale',
            referenceId: saleId,
            action: 'making sales',
          });
        }

        if (payments.length > 0) {
          await trx
            .insertInto('sale_payments')
            .values(
              payments.map((p) => ({
                id: uuidv7(),
                organization_id: auth.organizationId,
                sale_id: saleId,
                method: p.method,
                amount_kobo: p.amountKobo,
                reference: p.reference?.trim() || null,
                tendered_kobo: p.tenderedKobo ?? null,
                wallet_transaction_id: p.method === 'wallet' ? walletTxnId : null,
                debt_record_id: p.method === 'credit' ? debtId : null,
              })),
            )
            .execute();
        }

        // DEL-01: delivery orders and pre-orders join the fulfilment queue with the sale.
        const queued =
          fulfilment && dto.delivery
            ? await this.deliveries.enqueue(trx, {
                organizationId: auth.organizationId,
                actorId: auth.userId,
                saleId,
                locationId: session.location_id,
                customerId: customer?.id ?? null,
                fulfilment,
                address: fulfilment === 'delivery' ? (dto.delivery.address?.trim() ?? null) : null,
                scheduledDate: dto.delivery.date,
                driverId: fulfilment === 'delivery' ? (dto.delivery.driverId ?? null) : null,
                codKobo: plan.codKobo,
              })
            : null;

        // ── Events ────────────────────────────────────────────────────────────
        const meta = { locationId: session.location_id };
        await this.events.record(trx, {
          ...meta,
          type: EventTypes.SaleCompleted,
          aggregateType: 'sale',
          aggregateId: saleId,
          occurredAt,
          payload: {
            number,
            orderType: dto.orderType,
            customerId: customer?.id ?? null,
            registerSessionId: session.id,
            subtotalKobo: priced.subtotalKobo,
            discountKobo: priced.discountKobo,
            totalKobo: priced.totalKobo,
            creditKobo: plan.creditKobo,
            items: priced.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPriceKobo: l.unitPriceKobo, lineTotalKobo: l.lineTotalKobo })),
            payments: payments.map((p) => ({ method: p.method, amountKobo: p.amountKobo })),
            delivery: queued && dto.delivery
              ? { deliveryId: queued.deliveryId, fulfilment, date: dto.delivery.date, driverId: dto.delivery.driverId ?? null, codKobo: plan.codKobo }
              : null,
            approvedBy,
            approvalReasons: recordedReasons,
            recordedOffline: Boolean(offline),
          },
        });
        if (offline && offline.flags.length > 0) {
          await this.events.record(trx, {
            ...meta,
            type: EventTypes.SyncFlagged,
            aggregateType: 'sale',
            aggregateId: saleId,
            occurredAt,
            payload: { number, flags: [...offline.flags], priceMismatches, claimedApproverId: offline.approvedById },
          });
        }
        if (debtId && customer) {
          await this.events.record(trx, {
            ...meta,
            type: EventTypes.DebtCreated,
            aggregateType: 'customer',
            aggregateId: customer.id,
            payload: { debtRecordId: debtId, saleId, amountKobo: plan.creditKobo },
          });
        }
        if (walletTxnId && customer) {
          await this.events.record(trx, {
            ...meta,
            type: EventTypes.WalletDebited,
            aggregateType: 'customer',
            aggregateId: customer.id,
            payload: { transactionId: walletTxnId, saleId, amountKobo: -plan.walletKobo, after: { balanceKobo: walletBalanceAfter } },
          });
        }
        if (creditDetail && customer) {
          await this.events.record(trx, {
            ...meta,
            type: EventTypes.CreditLimitOverridden,
            aggregateType: 'customer',
            aggregateId: customer.id,
            payload: { saleId, approvedBy, ...creditDetail },
          });
        }

        return this.detail(trx, auth, saleId);
      });
    } catch (err) {
      if (err instanceof PricingError) throw new BadRequestException(err.message);
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION && dto.id) {
        // Two submissions of the same sale raced; the other one won. Return it.
        return this.get(auth, dto.id);
      }
      throw err;
    }
  }

  /**
   * Reverses a completed sale: stock back on the shelf, wallet refunded, debt cancelled, cash out
   * of the voider's till. Transfers and card payments are listed for manual refund. A sale whose
   * debt has already been partly repaid can't be voided (the repayment would be orphaned).
   */
  async void(auth: AuthContext, saleId: string, dto: VoidSaleDto): Promise<VoidSaleResultDto> {
    const approverId = dto.managerApproval ? await this.managerApproval.verify(auth, dto.managerApproval) : null;
    if (!isSupervisor(auth.role) && !approverId) {
      throw new HttpException(
        {
          statusCode: HttpStatus.CONFLICT,
          error: 'MANAGER_APPROVAL_REQUIRED',
          message: 'A manager must approve voiding a sale. Ask them to enter their PIN, then resubmit with managerApproval.',
          reasons: ['void'],
        },
        HttpStatus.CONFLICT,
      );
    }
    const reason = dto.reason.trim();

    return this.tenantDb.transaction(async (trx) => {
      const sale = await trx.selectFrom('sales').selectAll().where('id', '=', saleId).forUpdate().executeTakeFirst();
      if (!sale) throw new NotFoundException('Sale not found');
      if (sale.status === 'voided') throw new BadRequestException(`Sale #${sale.number} is already voided`);

      // Cancel its delivery (refused if already delivered and paid at the door).
      await this.deliveries.cancelForSale(trx, saleId, { organizationId: auth.organizationId, userId: auth.userId }, reason);

      const payments = await trx.selectFrom('sale_payments').selectAll().where('sale_id', '=', saleId).execute();
      const sum = (method: string) => payments.filter((p) => p.method === method).reduce((t, p) => t + p.amount_kobo, 0);
      const cashKobo = sum('cash');
      const walletKobo = sum('wallet');

      // Credit: cancel the debt, unless the customer has already paid some of it.
      const debt = await trx.selectFrom('debt_records').selectAll().where('sale_id', '=', saleId).forUpdate().executeTakeFirst();
      if (debt && debt.paid_kobo > 0) {
        throw new BadRequestException(
          `Sale #${sale.number} can't be voided: ${debt.paid_kobo} kobo has already been repaid on its debt.`,
        );
      }
      if (debt) {
        await trx.updateTable('debt_records').set({ voided_at: sql`now()` }).where('id', '=', debt.id).execute();
      }

      // Cash comes out of a till, so the voider must be clocked in to hand it back.
      if (cashKobo > 0) {
        await this.registers.recordCashInOpenSession(trx, auth, {
          kind: 'cash_refund',
          amountKobo: -cashKobo,
          referenceType: 'sale_void',
          referenceId: saleId,
          action: 'refunding cash',
        });
      }

      let walletRefundTxn: string | null = null;
      if (walletKobo > 0 && sale.customer_id) {
        walletRefundTxn = uuidv7();
        await this.wallets.record(trx, {
          id: walletRefundTxn,
          organizationId: auth.organizationId,
          customerId: sale.customer_id,
          type: 'refund',
          amountKobo: walletKobo,
          actorId: auth.userId,
          referenceType: 'sale_void',
          referenceId: saleId,
        });
      }

      // Stock back on the shelf, at the branch it was sold from.
      const items = await trx
        .selectFrom('sale_items as i')
        .innerJoin('products as p', 'p.id', 'i.product_id')
        .select(['i.product_id', 'i.quantity', 'p.tracks_stock'])
        .where('i.sale_id', '=', saleId)
        .execute();
      const tracked = items.filter((i) => i.tracks_stock);
      if (tracked.length > 0) {
        await this.stock.record(
          trx,
          tracked.map((i) => ({
            productId: i.product_id,
            locationId: sale.location_id,
            type: 'sale_reversal' as const,
            quantityDelta: i.quantity,
            referenceType: 'sale_void',
            referenceId: saleId,
          })),
          { organizationId: auth.organizationId, actorId: auth.userId, batchId: uuidv7() },
        );
      }

      await trx
        .updateTable('sales')
        .set({ status: 'voided', voided_at: sql`now()`, voided_by: auth.userId, void_reason: reason, void_approved_by: approverId })
        .where('id', '=', saleId)
        .execute();

      const manualRefunds: ManualRefundDto[] = payments
        .filter((p): p is typeof p & { method: 'transfer' | 'card' } => p.method === 'transfer' || p.method === 'card')
        .map((p) => ({ method: p.method, amountKobo: p.amount_kobo, reference: p.reference }));
      const reversed = {
        cashRefundKobo: cashKobo,
        walletRefundKobo: walletKobo,
        debtVoidedKobo: debt?.amount_kobo ?? 0,
        stockLinesRestored: tracked.length,
      };

      await this.events.record(trx, {
        type: EventTypes.SaleVoided,
        aggregateType: 'sale',
        aggregateId: saleId,
        locationId: sale.location_id,
        payload: {
          number: sale.number,
          reason,
          approvedBy: approverId,
          before: { status: 'completed', totalKobo: sale.total_kobo },
          after: { status: 'voided' },
          reversed,
          manualRefunds,
        },
      });
      if (debt && sale.customer_id) {
        await this.events.record(trx, {
          type: EventTypes.DebtVoided,
          aggregateType: 'customer',
          aggregateId: sale.customer_id,
          locationId: sale.location_id,
          payload: { debtRecordId: debt.id, saleId, amountKobo: debt.amount_kobo },
        });
      }
      if (walletRefundTxn && sale.customer_id) {
        await this.events.record(trx, {
          type: EventTypes.WalletRefunded,
          aggregateType: 'customer',
          aggregateId: sale.customer_id,
          locationId: sale.location_id,
          payload: { transactionId: walletRefundTxn, saleId, amountKobo: walletKobo },
        });
      }

      return { sale: await this.detail(trx, null, saleId), reversed, manualRefunds };
    });
  }

  async list(auth: AuthContext, query: ListSalesQueryDto): Promise<SalePageDto> {
    const limit = query.limit ?? 50;
    const cursor = query.cursor ? decodeCursor(query.cursor, 2) : null;
    const ownOnly = !isSupervisor(auth.role);

    const rows = await this.tenantDb.transaction((trx) =>
      trx
        .selectFrom('sales as s')
        .innerJoin('users as u', 'u.id', 's.cashier_id')
        .leftJoin('customers as c', 'c.id', 's.customer_id')
        .select([
          's.id',
          's.number',
          's.status',
          's.order_type',
          's.total_kobo',
          's.credit_kobo',
          's.cashier_id',
          'u.full_name as cashier_name',
          'c.name as customer_name',
          's.occurred_at',
        ])
        .$if(ownOnly, (qb) => qb.where('s.cashier_id', '=', auth.userId))
        .$if(!ownOnly && !!query.cashierId, (qb) => qb.where('s.cashier_id', '=', query.cashierId!))
        .$if(!!query.customerId, (qb) => qb.where('s.customer_id', '=', query.customerId!))
        .$if(!!query.registerSessionId, (qb) => qb.where('s.register_session_id', '=', query.registerSessionId!))
        .$if(!!query.orderType, (qb) => qb.where('s.order_type', '=', query.orderType!))
        .$if(!!query.status, (qb) => qb.where('s.status', '=', query.status!))
        .$if(!!query.from, (qb) => qb.where('s.occurred_at', '>=', new Date(query.from!)))
        .$if(!!query.to, (qb) => qb.where('s.occurred_at', '<', new Date(query.to!)))
        .$if(cursor !== null, (qb) => qb.where(sql<boolean>`(s.occurred_at, s.id) < (${new Date(cursor![0]!)}, ${cursor![1]!})`))
        .orderBy('s.occurred_at', 'desc')
        .orderBy('s.id', 'desc')
        .limit(limit + 1)
        .execute(),
    );

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        orderType: r.order_type,
        totalKobo: r.total_kobo,
        creditKobo: r.credit_kobo,
        cashierId: r.cashier_id,
        cashierName: r.cashier_name,
        customerName: r.customer_name,
        occurredAt: r.occurred_at,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor([last.occurred_at.toISOString(), last.id]) : null,
    };
  }

  async get(auth: AuthContext, id: string): Promise<SaleDto> {
    return this.tenantDb.transaction((trx) => this.detail(trx, auth, id));
  }

  // ─── Internals ─────────────────────────────────────────────────────────────────

  /** viewer null = already authorized elsewhere (e.g. a signed receipt link). */
  async detail(trx: Trx, viewer: AuthContext | null, id: string): Promise<SaleDto> {
    const s = await trx
      .selectFrom('sales as s')
      .innerJoin('users as cashier', 'cashier.id', 's.cashier_id')
      .innerJoin('locations as l', 'l.id', 's.location_id')
      .innerJoin('registers as r', 'r.id', 's.register_id')
      .leftJoin('customers as c', 'c.id', 's.customer_id')
      .leftJoin('deliveries as dl', 'dl.sale_id', 's.id')
      .leftJoin('users as driver', 'driver.id', 'dl.driver_id')
      .leftJoin('users as approver', 'approver.id', 's.approved_by')
      .selectAll('s')
      .select([
        'cashier.full_name as cashier_name',
        'l.name as location_name',
        'r.name as register_name',
        'c.name as customer_name',
        'c.phone as customer_phone',
        'driver.full_name as driver_name',
        'dl.id as dl_id',
        'dl.status as dl_status',
        'dl.fulfilment as dl_fulfilment',
        'dl.address as dl_address',
        'dl.scheduled_date as dl_date',
        'dl.driver_id as dl_driver_id',
        'dl.confirmation_code as dl_code',
        'approver.full_name as approver_name',
      ])
      .where('s.id', '=', id)
      .executeTakeFirst();
    if (!s || (viewer && !isSupervisor(viewer.role) && s.cashier_id !== viewer.userId)) throw new NotFoundException('Sale not found');

    const [items, payments] = await Promise.all([
      trx.selectFrom('sale_items').selectAll().where('sale_id', '=', id).orderBy('line_no').execute(),
      trx.selectFrom('sale_payments').selectAll().where('sale_id', '=', id).orderBy('id').execute(),
    ]);

    return {
      id: s.id,
      number: s.number,
      status: s.status,
      orderType: s.order_type,
      totalKobo: s.total_kobo,
      creditKobo: s.credit_kobo,
      cashierId: s.cashier_id,
      cashierName: s.cashier_name,
      customerName: s.customer_name,
      occurredAt: s.occurred_at,
      locationId: s.location_id,
      locationName: s.location_name,
      registerId: s.register_id,
      registerName: s.register_name,
      registerSessionId: s.register_session_id,
      customer: s.customer_id && s.customer_name ? { id: s.customer_id, name: s.customer_name, phone: s.customer_phone } : null,
      subtotalKobo: s.subtotal_kobo,
      discountKobo: s.discount_kobo,
      paidKobo: s.paid_kobo,
      changeKobo: s.change_kobo,
      items: items.map((i) => ({
        lineNo: i.line_no,
        productId: i.product_id,
        productName: i.product_name,
        unit: i.unit,
        quantity: i.quantity,
        unitPriceKobo: i.unit_price_kobo,
        discountKobo: i.discount_kobo,
        lineTotalKobo: i.line_total_kobo,
      })),
      payments: payments.map((p) => ({ method: p.method, amountKobo: p.amount_kobo, tenderedKobo: p.tendered_kobo, reference: p.reference })),
      delivery:
        s.dl_id && s.dl_fulfilment && s.dl_status && s.dl_date
          ? {
              deliveryId: s.dl_id,
              fulfilment: s.dl_fulfilment,
              status: s.dl_status,
              address: s.dl_address,
              date: s.dl_date,
              driverId: s.dl_driver_id,
              driverName: s.driver_name,
              codKobo: s.cod_kobo,
              confirmationCode: viewer?.role === 'driver' ? null : s.dl_code,
            }
          : null,
      note: s.note,
      approvedById: s.approved_by,
      approvedByName: s.approver_name,
      approvalReasons: s.approval_reasons ?? [],
      createdAt: s.created_at,
      voidedAt: s.voided_at,
      voidReason: s.void_reason,
    };
  }

  private async outstandingDebt(trx: Trx, customerId: string): Promise<number> {
    const row = await trx
      .selectFrom('debt_records')
      .select(sql<number>`coalesce(sum(amount_kobo - paid_kobo), 0)::bigint`.as('outstanding'))
      .where('customer_id', '=', customerId)
      .where('status', '=', 'open')
      .executeTakeFirstOrThrow();
    return Number(row.outstanding);
  }

  /** Gap-free per business. The counter row lock is held until commit, so numbers are never reused. */
  private async nextNumber(trx: Trx, organizationId: string, name: string): Promise<number> {
    const row = await trx
      .insertInto('document_counters')
      .values({ organization_id: organizationId, name, last_value: 1 })
      .onConflict((oc) => oc.columns(['organization_id', 'name']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` }))
      .returning('last_value')
      .executeTakeFirstOrThrow();
    return row.last_value;
  }
}

function resolveOccurredAt(input: string | undefined, maxBackdateMs: number): Date {
  if (!input) return new Date();
  const at = new Date(input);
  const now = Date.now();
  if (at.getTime() > now + MAX_CLOCK_SKEW_MS) throw new BadRequestException('occurredAt is in the future; check the device clock');
  if (at.getTime() < now - maxBackdateMs) {
    throw new BadRequestException(`occurredAt is more than ${Math.round(maxBackdateMs / 3_600_000)} hours ago`);
  }
  return at;
}
