import { types } from 'pg';

/**
 * Money is stored as bigint kobo. node-postgres returns bigint (int8) as a string by
 * default; convert it to a JS number, refusing anything outside the safe-integer range
 * (±9 quadrillion kobo ≈ ₦90 trillion, far beyond any single SME value).
 *
 * Note: SUM(bigint) returns numeric, not bigint. Cast sums back: `sum(x)::bigint`.
 */
const INT8_OID = 20;

types.setTypeParser(INT8_OID, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint value ${value} exceeds the safe integer range`);
  return n;
});

/**
 * DATE columns (e.g. delivery_date) stay as 'YYYY-MM-DD' strings. Converting them to JS Dates
 * would place them at local midnight and can shift the day across timezones.
 */
const DATE_OID = 1082;
types.setTypeParser(DATE_OID, (value: string) => value);
