import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Public base URL of this API, used to build shareable receipt links. */
  PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),
  SWAGGER_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

  DATABASE_APP_URL: z.string().url(),
  DATABASE_SYSTEM_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  PIN_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(14),

  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),

  // Scheduled jobs and outgoing notifications (worker)
  SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(60_000),
  NOTIFICATION_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),

  // Push via Firebase Cloud Messaging: base64 of the service-account JSON. Omit to disable push.
  FCM_SERVICE_ACCOUNT_BASE64: z.string().optional(),

  // SMS via Termii (termii.com). Omit TERMII_API_KEY to disable SMS.
  TERMII_API_KEY: z.string().optional(),
  TERMII_SENDER_ID: z.string().max(11).default('SoftLife'),
  /** 'dnd' reaches numbers on Do-Not-Disturb (needed for most Nigerian lines); 'generic' is cheaper. */
  TERMII_CHANNEL: z.enum(['dnd', 'generic', 'whatsapp']).default('dnd'),
  TERMII_BASE_URL: z.string().url().default('https://api.ng.termii.com'),

  // File storage: exports and delivery signatures.
  //   local: files on this machine's disk (development, single server)
  //   s3:    any S3-compatible bucket (AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO)
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  /** Leave empty for AWS; set for R2 / Spaces / MinIO, e.g. https://<account>.r2.cloudflarestorage.com */
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  EXPORT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3_000),
}).superRefine((env, ctx) => {
  if (env.STORAGE_DRIVER === 's3') {
    for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
      if (!env[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `required when STORAGE_DRIVER=s3` });
    }
  }
});

export type Env = z.infer<typeof envSchema>;

/** Fail fast at boot with a readable message instead of failing at the first request. */
export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
