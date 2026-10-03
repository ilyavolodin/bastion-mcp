/**
 * The test setup fails a test whose screen changes a stored row without `If-Match` (17.1). A test of the mock itself
 * sends such changes on purpose, to see the mock answer 428: it calls `allowMissingIfMatch()` first (reset for the
 * next test).
 */
export const ifMatchPolicy = { tolerate: false };

export const allowMissingIfMatch = (): void => {
  ifMatchPolicy.tolerate = true;
};
