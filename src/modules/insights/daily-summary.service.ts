import { Injectable } from '@nestjs/common';
import { sql, Transaction } from 'kysely';
import type { DB } from '../../database/database.types';
import type { DailySummary } from './digest-format';

/**
 * One business day at a glance (INS-01): the evening digest and the dashboard both use this.
 * "Today" means the business's local day in its own timezone, not the server's.
 */
@Injectable()
export class DailySummaryService {
  async build(trx: Transaction<DB>, date: string, timezone: string, locationId?: string): Promise<DailySummary> {
    const start = sql<Date>`(${date}::date)::timestamp AT TIME ZONE ${timezone}`;
    const end = sql<Date>`((${date}::date) + 1)::timestamp AT TIME ZONE ${timezone}`;

    const [sales, methods, top, closings, stillOpen, debt, repaid, walletTopUps, low, deliveries, driverCash] = await Promise.all([
      trx
        .selectFrom('sales')
        .select([
          sql<number>`count(*) filter (where status = 'completed')`.as('count'),
          sql<number>`coalesce(sum(total_kobo) filter (where status = 'completed'), 0)::bigint`.as('total'),
          sql<number>`count(*) filter (where status = 'voided')`.as('voided'),
        ])
        .where('occurred_at', '>=', start)
        .where('occurred_at', '<', end)
        .$if(!!locationId, (qb) => qb.where('location_id', '=', locationId!))
        .executeTakeFirstOrThrow(),
      trx
        .selectFrom('sale_payments as p')
        .innerJoin('sales as s', 's.id', 'p.sale_id')
        .select(['p.method', sql<number>`sum(p.amount_kobo)::bigint`.as('total')])
        .where('s.status', '=', 'completed')
        .where('s.occurred_at', '>=', start)
        .where('s.occurred_at', '<', end)
        .$if(!!locationId, (qb) => qb.where('s.location_id', '=', locationId!))
        .groupBy('p.method')
        .execute(),
      trx
        .selectFrom('sale_items as i')
        .innerJoin('sales as s', 's.id', 'i.sale_id')
        .select([
          'i.product_id',
          sql<string>`max(i.product_name)`.as('name'),
          sql<number>`sum(i.quantity)::bigint`.as('quantity'),
          sql<number>`sum(i.line_total_kobo)::bigint`.as('revenue'),
        ])
        .where('s.status', '=', 'completed')
        .where('s.occurred_at', '>=', start)
        .where('s.occurred_at', '<', end)
        .$if(!!locationId, (qb) => qb.where('s.location_id', '=', locationId!))
        .groupBy('i.product_id')
        .orderBy('revenue', 'desc')
        .limit(5)
        .execute(),
      trx
        .selectFrom('register_sessions')
        .select([
          sql<number>`count(*) filter (where variance_flagged)`.as('flagged'),
          sql<number>`coalesce(sum(variance_kobo) filter (where variance_flagged), 0)::bigint`.as('variance'),
        ])
        .where('status', '=', 'closed')
        .where('closed_at', '>=', start)
        .where('closed_at', '<', end)
        .$if(!!locationId, (qb) => qb.where('location_id', '=', locationId!))
        .executeTakeFirstOrThrow(),
      trx
        .selectFrom('register_sessions as s')
        .innerJoin('registers as r', 'r.id', 's.register_id')
        .innerJoin('users as u', 'u.id', 's.user_id')
        .select(['r.name as register_name', 'u.full_name as staff_name', 's.opened_at'])
        .where('s.status', '=', 'open')
        .$if(!!locationId, (qb) => qb.where('s.location_id', '=', locationId!))
        .orderBy('s.opened_at')
        .execute(),
      trx
        .selectFrom('debt_records')
        .select([
          sql<number>`coalesce(sum(amount_kobo) filter (where created_at >= ${start} and created_at < ${end} and status <> 'voided'), 0)::bigint`.as('new_credit'),
          sql<number>`coalesce(sum(amount_kobo - paid_kobo) filter (where status = 'open'), 0)::bigint`.as('outstanding'),
          sql<number>`coalesce(sum(amount_kobo - paid_kobo) filter (where status = 'open' and created_at < now() - interval '90 days'), 0)::bigint`.as('over90'),
        ])
        .executeTakeFirstOrThrow(),
      trx
        .selectFrom('debt_repayments')
        .select(sql<number>`coalesce(sum(amount_kobo), 0)::bigint`.as('total'))
        .where('created_at', '>=', start)
        .where('created_at', '<', end)
        .executeTakeFirstOrThrow(),
      trx
        .selectFrom('wallet_transactions')
        .select(sql<number>`coalesce(sum(amount_kobo), 0)::bigint`.as('total'))
        .where('type', '=', 'top_up')
        .where('created_at', '>=', start)
        .where('created_at', '<', end)
        .executeTakeFirstOrThrow(),
      trx
        .selectFrom('stock_levels as l')
        .innerJoin('products as p', 'p.id', 'l.product_id')
        .select(['p.name', 'l.quantity'])
        .where('p.is_active', '=', true)
        .where('p.reorder_level', 'is not', null)
        .whereRef('l.quantity', '<=', 'p.reorder_level')
        .$if(!!locationId, (qb) => qb.where('l.location_id', '=', locationId!))
        .orderBy('l.quantity')
        .execute(),
      trx
        .selectFrom('deliveries')
        .select([
          sql<number>`count(*) filter (where status = 'delivered' and delivered_at >= ${start} and delivered_at < ${end})`.as('delivered'),
          sql<number>`count(*) filter (where status in ('queued','assigned','out_for_delivery') and scheduled_date <= ${date}::date)`.as('pending'),
          sql<number>`count(*) filter (where status = 'failed')`.as('failed'),
        ])
        .$if(!!locationId, (qb) => qb.where('location_id', '=', locationId!))
        .executeTakeFirstOrThrow(),
      trx
        .selectFrom('delivery_collections as c')
        .innerJoin('deliveries as d', 'd.id', 'c.delivery_id')
        .select(sql<number>`coalesce(sum(c.amount_kobo), 0)::bigint`.as('total'))
        .where('c.method', '=', 'cash')
        .where('c.remittance_id', 'is', null)
        .where('d.fulfilment', '=', 'delivery')
        .$if(!!locationId, (qb) => qb.where('d.location_id', '=', locationId!))
        .executeTakeFirstOrThrow(),
    ]);

    return {
      date,
      sales: {
        count: Number(sales.count),
        totalKobo: Number(sales.total),
        voidedCount: Number(sales.voided),
        byMethod: Object.fromEntries(methods.map((m) => [m.method, Number(m.total)])),
      },
      topProducts: top.map((t) => ({ productId: t.product_id, name: t.name, quantity: Number(t.quantity), revenueKobo: Number(t.revenue) })),
      registers: {
        flaggedClosings: Number(closings.flagged),
        netVarianceKobo: Number(closings.variance),
        stillOpen: stillOpen.map((s) => ({ registerName: s.register_name, staffName: s.staff_name, openedAt: s.opened_at })),
      },
      debt: {
        newCreditKobo: Number(debt.new_credit),
        repaidKobo: Number(repaid.total),
        outstandingKobo: Number(debt.outstanding),
        over90DaysKobo: Number(debt.over90),
      },
      wallets: { toppedUpKobo: Number(walletTopUps.total) },
      stock: { lowCount: low.length, lowItems: low.slice(0, 10).map((l) => ({ name: l.name, quantity: l.quantity })) },
      deliveries: {
        delivered: Number(deliveries.delivered),
        pending: Number(deliveries.pending),
        failed: Number(deliveries.failed),
        cashWithDriversKobo: Number(driverCash.total),
      },
    };
  }
}
