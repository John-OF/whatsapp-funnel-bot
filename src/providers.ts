import type { Env } from './config/env.js';
import type { CrmProvider } from './crm/CrmProvider.js';
import { HubspotCrmProvider } from './crm/HubspotCrmProvider.js';
import { NoopCrmProvider } from './crm/NoopCrmProvider.js';
import { MockPaymentProvider } from './payments/MockPaymentProvider.js';
import { PayphoneProvider } from './payments/PayphoneProvider.js';
import type { PaymentProvider } from './payments/PaymentProvider.js';

export function createPaymentProvider(env: Env): PaymentProvider {
  if (env.PAYMENT_PROVIDER === 'mock') return new MockPaymentProvider(env.PUBLIC_BASE_URL);
  return new PayphoneProvider({
    token: env.PAYPHONE_TOKEN,
    storeId: env.PAYPHONE_STORE_ID,
    apiBase: env.PAYPHONE_API_BASE,
    expiresHours: env.PAYMENT_LINK_EXPIRES_HOURS,
  });
}

export function createCrmProvider(env: Env): CrmProvider {
  if (env.CRM_PROVIDER === 'none') return new NoopCrmProvider();
  return new HubspotCrmProvider(env.HUBSPOT_TOKEN);
}
