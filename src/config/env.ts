import 'dotenv/config';
import { z } from 'zod';

const schema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    PUBLIC_BASE_URL: z.string().url(),
    ADMIN_TOKEN: z.string().min(1),
    DATABASE_URL: z.string().min(1).default('file:./dev.db'),

    WHATSAPP_TOKEN: z.string().default(''),
    WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
    WHATSAPP_VERIFY_TOKEN: z.string().default(''),
    WHATSAPP_APP_SECRET: z.string().default(''),
    GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v23.0'),

    PRIVACY_POLICY_URL: z.string().url(),
    INTRO_VIDEO_URL: z.string().url(),
    BOOKING_URL: z.string().url(),

    PAYMENT_PROVIDER: z.enum(['mock', 'payphone']).default('mock'),
    PAYPHONE_TOKEN: z.string().default(''),
    PAYPHONE_STORE_ID: z.string().default(''),
    PAYPHONE_API_BASE: z.string().url().default('https://pay.payphonetodoesposible.com'),
    PAYPHONE_NOTIFICATIONS_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    PAYMENT_LINK_EXPIRES_HOURS: z.coerce.number().positive().default(1),
    PAYMENT_POLL_INTERVAL_SECONDS: z.coerce.number().positive().default(20),
    PAYMENT_POLL_MAX_MINUTES: z.coerce.number().positive().default(30),

    CRM_PROVIDER: z.enum(['none', 'hubspot']).default('none'),
    HUBSPOT_TOKEN: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    const require = (cond: boolean, path: string, why: string) => {
      if (!cond) ctx.addIssue({ code: 'custom', path: [path], message: `Obligatoria ${why}` });
    };
    require(env.PAYMENT_PROVIDER !== 'payphone' || !!env.PAYPHONE_TOKEN, 'PAYPHONE_TOKEN', 'con PAYMENT_PROVIDER=payphone');
    require(env.PAYMENT_PROVIDER !== 'payphone' || !!env.PAYPHONE_STORE_ID, 'PAYPHONE_STORE_ID', 'con PAYMENT_PROVIDER=payphone');
    require(env.CRM_PROVIDER !== 'hubspot' || !!env.HUBSPOT_TOKEN, 'HUBSPOT_TOKEN', 'con CRM_PROVIDER=hubspot');
  });

export type Env = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Variables de entorno inválidas:\n${lines.join('\n')}`);
  }
  return result.data;
}

let cached: Env | undefined;

/** Valida `process.env` una sola vez y falla con un mensaje claro si algo falta. */
export function getEnv(): Env {
  return (cached ??= parseEnv(process.env));
}
