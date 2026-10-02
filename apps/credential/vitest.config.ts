import { mergeConfig } from 'vitest/config';
import { createVitestConfig } from '../../vitest.shared';

// main.ts, browser.ts and keyring-store.ts are thin shells over the OS (argv, browser, keychain);
// everything they delegate to is tested through ports.
export default mergeConfig(createVitestConfig({ name: 'credential' }), {
  test: { coverage: { exclude: ['src/main.ts', 'src/browser.ts', 'src/keyring-store.ts'] } },
});
