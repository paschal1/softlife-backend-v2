import type { OrderType, SalePaymentMethod } from '../../database/database.types';

/**
 * Pure sale arithmetic: no database, no framework. Every number the customer pays is decided
 * here, so it is unit-tested exhaustively. All amounts are integer kobo.
 */

export interface PricedProduct {
  id: string;
  name: string;
  unit: string;
  sellingPriceKobo: number;
  wholesalePriceKobo: number | null;
}

export interface LineInput {
  productId: string;
  quantity: number;
  discountKobo?: number;
  /**
   * Offline sync only: the price the till actually charged from its cached catalogue.
   * The sale already happened at this price, so it is honoured (and flagged if it differs).
   */
  unitPriceKobo?: number;
}

export interface PricedLine {
  lineNo: number;
  productId: string;
  productName: string;
  unit: string;
  quantity: number;
  unitPriceKobo: number;
  /** The catalogue price at the time the server priced it. Differs from unitPriceKobo only for offline sales. */
  catalogPriceKobo: number;
  discountKobo: number;
  lineTotalKobo: number;
}

export interface PricedSale {
  lines: PricedLine[];
  subtotalKobo: number;
  discountKobo: number;
  totalKobo: number;
}

export class PricingError extends Error {}

/** Wholesale orders use the wholesale price where one is set (CUST-02); everything else uses retail. */
export function unitPriceFor(product: PricedProduct, orderType: OrderType): number {
  return orderType === 'wholesale' && product.wholesalePriceKobo !== null ? product.wholesalePriceKobo : product.sellingPriceKobo;
}

export function priceSale(lines: LineInput[], products: Map<string, PricedProduct>, orderType: OrderType): PricedSale {
  if (lines.length === 0) throw new PricingError('A sale needs at least one item');

  const priced = lines.map((line, i): PricedLine => {
    const product = products.get(line.productId);
    if (!product) throw new PricingError(`Product ${line.productId} not found`);
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) throw new PricingError(`Quantity for ${product.name} must be a whole number above zero`);

    const catalogPriceKobo = unitPriceFor(product, orderType);
    const unitPriceKobo = line.unitPriceKobo ?? catalogPriceKobo;
    if (!Number.isInteger(unitPriceKobo) || unitPriceKobo < 0) throw new PricingError(`Price for ${product.name} must be whole kobo, zero or more`);
    const gross = unitPriceKobo * line.quantity;
    const discountKobo = line.discountKobo ?? 0;
    if (!Number.isInteger(discountKobo) || discountKobo < 0) throw new PricingError('Discounts must be whole kobo amounts, zero or more');
    if (discountKobo > gross) throw new PricingError(`Discount on ${product.name} is more than the line is worth`);

    return {
      lineNo: i + 1,
      productId: product.id,
      productName: product.name,
      unit: product.unit,
      quantity: line.quantity,
      unitPriceKobo,
      catalogPriceKobo,
      discountKobo,
      lineTotalKobo: gross - discountKobo,
    };
  });

  const subtotalKobo = priced.reduce((s, l) => s + l.unitPriceKobo * l.quantity, 0);
  const discountKobo = priced.reduce((s, l) => s + l.discountKobo, 0);
  return { lines: priced, subtotalKobo, discountKobo, totalKobo: subtotalKobo - discountKobo };
}

export interface PaymentInput {
  method: SalePaymentMethod;
  amountKobo: number;
  /** Cash handed over. Change = tendered − amount. */
  tenderedKobo?: number;
  reference?: string;
}

export interface PaymentPlan {
  paidKobo: number; // paid now: everything except credit and pay-on-delivery
  creditKobo: number;
  codKobo: number;
  cashKobo: number;
  walletKobo: number;
  changeKobo: number;
}

/** POS-03: the payments must add up to the total exactly. */
export function planPayments(totalKobo: number, payments: PaymentInput[]): PaymentPlan {
  if (payments.length === 0 && totalKobo > 0) throw new PricingError('Add at least one payment');

  const methodsSeen = new Set<SalePaymentMethod>();
  let cashKobo = 0;
  let walletKobo = 0;
  let creditKobo = 0;
  let codKobo = 0;
  let otherKobo = 0;
  let changeKobo = 0;

  for (const p of payments) {
    if (!Number.isInteger(p.amountKobo) || p.amountKobo <= 0) throw new PricingError('Each payment must be a whole kobo amount above zero');
    // One line per method keeps receipts and reconciliation unambiguous. Two transfers? Add them up.
    if (p.method !== 'transfer' && p.method !== 'card' && methodsSeen.has(p.method)) {
      throw new PricingError(`Combine the ${p.method} payments into one`);
    }
    methodsSeen.add(p.method);

    if (p.tenderedKobo !== undefined) {
      if (p.method !== 'cash') throw new PricingError('Only cash payments take a tendered amount');
      if (p.tenderedKobo < p.amountKobo) throw new PricingError('Cash tendered is less than the cash amount');
      changeKobo += p.tenderedKobo - p.amountKobo;
    }
    if (p.method === 'transfer' && !p.reference?.trim()) throw new PricingError('A transfer payment needs its reference');

    if (p.method === 'cash') cashKobo += p.amountKobo;
    else if (p.method === 'wallet') walletKobo += p.amountKobo;
    else if (p.method === 'credit') creditKobo += p.amountKobo;
    else if (p.method === 'pay_on_delivery') codKobo += p.amountKobo;
    else otherKobo += p.amountKobo;
  }

  const sum = cashKobo + walletKobo + creditKobo + codKobo + otherKobo;
  if (sum !== totalKobo) {
    throw new PricingError(
      sum < totalKobo
        ? `Payments are ${totalKobo - sum} kobo short of the ${totalKobo} kobo total`
        : `Payments are ${sum - totalKobo} kobo more than the ${totalKobo} kobo total. For cash change, use tenderedKobo.`,
    );
  }

  return { paidKobo: sum - creditKobo - codKobo, creditKobo, codKobo, cashKobo, walletKobo, changeKobo };
}

export type CreditDecision =
  | { outcome: 'ok' }
  | { outcome: 'needs_approval'; limitKobo: number; projectedKobo: number }
  | { outcome: 'blocked'; limitKobo: number; projectedKobo: number };

/**
 * DEBT-02. A null limit means unlimited. Going over is either blocked (hard) or allowed
 * with a manager's PIN (soft, the default per Decision Q4).
 */
export function decideCredit(
  outstandingKobo: number,
  newCreditKobo: number,
  limitKobo: number | null,
  mode: 'soft' | 'hard',
): CreditDecision {
  if (newCreditKobo === 0 || limitKobo === null) return { outcome: 'ok' };
  const projectedKobo = outstandingKobo + newCreditKobo;
  if (projectedKobo <= limitKobo) return { outcome: 'ok' };
  return mode === 'hard'
    ? { outcome: 'blocked', limitKobo, projectedKobo }
    : { outcome: 'needs_approval', limitKobo, projectedKobo };
}
