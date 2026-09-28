export interface OutgoingMessage {
  title: string;
  body: string;
  data: Record<string, unknown>;
}

export interface NotificationChannel {
  readonly name: 'push' | 'sms';
  /** False when its credentials aren't configured: nothing is queued for it. */
  readonly enabled: boolean;
  /** Resolves when accepted by the provider. Throws PermanentDeliveryError to stop retrying. */
  send(target: string, message: OutgoingMessage): Promise<void>;
}

/** Retrying won't help (bad number, uninstalled app, rejected sender ID). */
export class PermanentDeliveryError extends Error {
  constructor(
    message: string,
    /** The target itself is dead (e.g. an uninstalled app's push token): stop using it. */
    readonly invalidTarget = false,
  ) {
    super(message);
  }
}
