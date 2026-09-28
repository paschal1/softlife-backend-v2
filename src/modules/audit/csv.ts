/**
 * RFC 4180 CSV that opens correctly in Excel and Google Sheets, with protection against
 * formula injection: a customer named "=HYPERLINK(...)" must not become a live formula
 * in the owner's spreadsheet.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',') + '\r\n';
}

/** UTF-8 byte-order mark: without it Excel on Windows shows ₦ and accented names as garbage. */
export const CSV_BOM = '\uFEFF';
