import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const base = {
  PUBLIC_BASE_URL: 'https://example.ngrok-free.app',
  ADMIN_TOKEN: 'secreto',
  PRIVACY_POLICY_URL: 'https://example.com/privacidad',
  INTRO_VIDEO_URL: 'https://youtube.com/watch?v=x',
  BOOKING_URL: 'https://cal.com/u/s',
};

describe('env', () => {
  it('acepta la configuración mínima con valores por defecto (mock + sin CRM)', () => {
    const env = parseEnv(base);
    expect(env).toMatchObject({ PORT: 3000, PAYMENT_PROVIDER: 'mock', CRM_PROVIDER: 'none', GRAPH_API_VERSION: 'v23.0' });
  });

  it('falla con mensaje claro si falta una variable obligatoria', () => {
    expect(() => parseEnv({ ...base, ADMIN_TOKEN: undefined })).toThrow(/ADMIN_TOKEN/);
  });

  it('payphone exige token y storeId', () => {
    expect(() => parseEnv({ ...base, PAYMENT_PROVIDER: 'payphone' })).toThrow(/PAYPHONE_TOKEN[\s\S]*PAYPHONE_STORE_ID/);
    expect(parseEnv({ ...base, PAYMENT_PROVIDER: 'payphone', PAYPHONE_TOKEN: 't', PAYPHONE_STORE_ID: 's' }).PAYMENT_PROVIDER).toBe('payphone');
  });

  it('hubspot exige token', () => {
    expect(() => parseEnv({ ...base, CRM_PROVIDER: 'hubspot' })).toThrow(/HUBSPOT_TOKEN/);
  });
});
