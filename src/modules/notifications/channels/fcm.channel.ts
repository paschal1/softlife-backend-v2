import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'node:crypto';
import type { Env } from '../../../config/env';
import { NotificationChannel, OutgoingMessage, PermanentDeliveryError } from './channel';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/**
 * Push notifications through Firebase Cloud Messaging (HTTP v1 API), for Android, iOS and web.
 * Authenticates with a service account (signed JWT exchanged for a 1-hour access token).
 */
@Injectable()
export class FcmChannel implements NotificationChannel {
  readonly name = 'push' as const;
  private readonly logger = new Logger(FcmChannel.name);
  private readonly account: ServiceAccount | null;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(config: ConfigService<Env, true>) {
    const encoded = config.get('FCM_SERVICE_ACCOUNT_BASE64', { infer: true });
    this.account = null;
    if (encoded) {
      try {
        const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as ServiceAccount;
        if (!parsed.project_id || !parsed.client_email || !parsed.private_key) throw new Error('missing fields');
        this.account = parsed;
      } catch (err) {
        this.logger.error(`FCM_SERVICE_ACCOUNT_BASE64 is not a valid service-account JSON: ${(err as Error).message}. Push disabled.`);
      }
    }
  }

  get enabled(): boolean {
    return this.account !== null;
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    if (!this.account) throw new PermanentDeliveryError('Push is not configured');
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: target,
          notification: { title: message.title, body: message.body },
          // FCM data values must be strings.
          data: Object.fromEntries(Object.entries(message.data).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])),
          android: { priority: 'high' },
        },
      }),
    });
    if (res.ok) return;

    const text = await res.text();
    if (res.status === 404 || text.includes('UNREGISTERED') || (res.status === 400 && /registration token/i.test(text))) {
      throw new PermanentDeliveryError('The app was uninstalled or its push token expired', true);
    }
    if (res.status === 401) this.token = null; // refresh and retry
    if (res.status === 401 || res.status === 429 || res.status >= 500) throw new Error(`FCM ${res.status}: ${text.slice(0, 200)}`);
    throw new PermanentDeliveryError(`FCM ${res.status}: ${text.slice(0, 200)}`);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const account = this.account!;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url');

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    });
    if (!res.ok) throw new Error(`FCM auth failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
    return json.access_token;
  }
}
