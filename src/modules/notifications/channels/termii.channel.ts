import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env';
import { NotificationChannel, OutgoingMessage, PermanentDeliveryError } from './channel';

/**
 * SMS through Termii, widely used in Nigeria. The 'dnd' channel reaches numbers on
 * Do-Not-Disturb, which most Nigerian lines are, so transactional alerts actually arrive.
 *
 * Only critical alerts and the daily digest go by SMS (it costs money per message).
 */
@Injectable()
export class TermiiChannel implements NotificationChannel {
  readonly name = 'sms' as const;
  private readonly apiKey: string | undefined;
  private readonly senderId: string;
  private readonly channel: string;
  private readonly baseUrl: string;

  constructor(config: ConfigService<Env, true>) {
    this.apiKey = config.get('TERMII_API_KEY', { infer: true }) || undefined;
    this.senderId = config.get('TERMII_SENDER_ID', { infer: true });
    this.channel = config.get('TERMII_CHANNEL', { infer: true });
    this.baseUrl = config.get('TERMII_BASE_URL', { infer: true }).replace(/\/$/, '');
  }

  get enabled(): boolean {
    return Boolean(this.apiKey);
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    if (!this.apiKey) throw new PermanentDeliveryError('SMS is not configured');
    const text = typeof message.data.sms === 'string' ? message.data.sms : `${message.title}. ${message.body}`;

    const res = await fetch(`${this.baseUrl}/api/sms/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        to: target.replace(/^\+/, ''), // Termii wants 2348031234567
        from: this.senderId,
        // ₦ and curly quotes would force Unicode SMS (70 chars, double cost).
        sms: toGsm(text).slice(0, 459), // 3 SMS segments max
        type: 'plain',
        channel: this.channel,
      }),
    });
    if (res.ok) return;
    const body = (await res.text()).slice(0, 200);
    if (res.status === 429 || res.status >= 500) throw new Error(`Termii ${res.status}: ${body}`);
    throw new PermanentDeliveryError(`Termii ${res.status}: ${body}`, res.status === 400 && /number|recipient/i.test(body));
  }
}

export function toGsm(text: string): string {
  return text
    .replace(/₦/g, 'NGN')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[−–—]/g, '-')
    .replace(/⚠\s?/g, '! ')
    .replace(/[^\x0A\x0D\x20-\x7E£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà]/g, '');
}
