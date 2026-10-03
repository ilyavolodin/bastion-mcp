import { mergeConfig } from 'vitest/config';
import { createVitestConfig } from '../../vitest.shared';

// main.ts is the process entrypoint (argv, signals, stdout); everything it calls is tested directly.
export default mergeConfig(createVitestConfig({ name: 'runner' }), {
  test: { coverage: { exclude: ['src/main.ts'] } },
});
