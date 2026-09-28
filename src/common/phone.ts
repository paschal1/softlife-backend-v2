/**
 * Normalizes phone numbers so "0803 123 4567", "08031234567", "2348031234567"
 * and "+234 803 123 4567" all resolve to the same login identity: "+2348031234567".
 *
 * Nigeria-first by design (the launch market). When SoftLife expands to other
 * countries, pass the organization's country code instead of the default.
 */
export function normalizePhone(input: string, defaultCountryCode = '234'): string {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, '');

  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.startsWith(defaultCountryCode)) return `+${digits}`;
  if (digits.startsWith('0')) return `+${defaultCountryCode}${digits.slice(1)}`;
  return `+${defaultCountryCode}${digits}`;
}
