import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

export const TEST_DATABASE_URL = 'file:./test.db';

/** Crea una base SQLite limpia con las migraciones reales para los tests de integración. */
export default function setup() {
  for (const f of ['prisma/test.db', 'prisma/test.db-journal']) rmSync(f, { force: true });
  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
