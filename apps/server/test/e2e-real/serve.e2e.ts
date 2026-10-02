import { it } from 'vitest';
import { launch } from './launch';

// Not a test: keeps the real stack up for the Playwright specs of `apps/web/e2e/real` until the process is killed.
it('serves the e2e stack', async () => {
  const { stop } = await launch();
  process.on('SIGTERM', () => void stop().then(() => process.exit(0)));
  await new Promise<void>(() => undefined);
}, 0);
