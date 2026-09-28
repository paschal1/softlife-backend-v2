import { csvCell, csvRow } from './csv';

describe('csv', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('Hello, "world"')).toBe('"Hello, ""world"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+2348031234567')).toBe("'+2348031234567");
    expect(csvCell('-5')).toBe("'-5");
  });

  it('writes a CRLF row, with empty cells for null', () => {
    expect(csvRow(['a', null, 3])).toBe('a,,3\r\n');
  });
});
