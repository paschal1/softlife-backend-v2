import { BadRequestException } from '@nestjs/common';

/** Opaque keyset cursor: the sort-key values of the last row on a page. */
export function encodeCursor(values: string[]): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

export function decodeCursor(cursor: string, expectedLength: number): string[] {
  try {
    const values: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(values) || values.length !== expectedLength || !values.every((v) => typeof v === 'string')) {
      throw new Error();
    }
    return values as string[];
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

/** Escapes %, _ and \ so user input is matched literally inside an ILIKE pattern. */
export function likeEscape(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}
