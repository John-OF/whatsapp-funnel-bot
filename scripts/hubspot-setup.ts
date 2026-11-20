import { getEnv } from '../src/config/env.js';
import { HubspotApi } from '../src/crm/hubspotApi.js';
import { ensureHubspotSchema, PROPERTY_GROUP } from '../src/crm/hubspotSchema.js';

async function main() {
  const { HUBSPOT_TOKEN } = getEnv();
  if (!HUBSPOT_TOKEN) throw new Error('Configura HUBSPOT_TOKEN en .env (ver docs/SETUP.md).');

  console.log(`Creando propiedades en el grupo "${PROPERTY_GROUP.name}"…`);
  const outcomes = await ensureHubspotSchema(new HubspotApi(HUBSPOT_TOKEN));
  for (const o of outcomes) console.log(`  ${o.result === 'created' ? '✅ creada ' : '↺ ya existe'}  ${o.name}`);
  console.log('\nListo. Puedes ejecutar este script las veces que quieras.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  if (String(err).includes('403') || String(err).includes('401')) {
    console.error('Revisa el token y los scopes: crm.objects.contacts.read/write y crm.schemas.contacts.write.');
  }
  process.exit(1);
});
