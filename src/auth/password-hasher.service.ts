import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/** argon2id for both passwords and PINs. */
@Injectable()
export class PasswordHasher {
  private dummyHash?: Promise<string>;

  hash(secret: string): Promise<string> {
    return argon2.hash(secret, { type: argon2.argon2id });
  }

  async verify(hash: string, secret: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, secret);
    } catch {
      return false;
    }
  }

  /**
   * Burn the same time as a real verification when the account doesn't exist,
   * so response timing doesn't reveal which emails/phones are registered.
   */
  async verifyAgainstDummy(secret: string): Promise<false> {
    this.dummyHash ??= this.hash('softlife-timing-equalizer');
    await this.verify(await this.dummyHash, secret);
    return false;
  }
}
