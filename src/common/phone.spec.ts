import { normalizePhone } from './phone';

describe('normalizePhone', () => {
  it.each([
    ['08031234567', '+2348031234567'],
    ['0803 123 4567', '+2348031234567'],
    ['2348031234567', '+2348031234567'],
    ['+234 803 123 4567', '+2348031234567'],
    ['+234-803-123-4567', '+2348031234567'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it('keeps explicit non-Nigerian international numbers as they are', () => {
    expect(normalizePhone('+233 24 123 4567')).toBe('+233241234567');
  });
});
