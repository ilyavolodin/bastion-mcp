/** Values every in-process server test shares; a change here moves all of them together. */

/** The server's public URL: https (the OAuth issuer must be), served by a plain-HTTP loopback listener. */
export const PUBLIC_URL = 'https://bastion.test';
export const PUBLIC_HOST = new URL(PUBLIC_URL).host;
export const TEST_INTERNAL_SECRET = 'x'.repeat(48);
/** The sandbox driver name the server is configured with (the tests substitute `LocalProcessDriver`). */
export const TEST_SANDBOX_DRIVER = 'bubblewrap';
export const TEST_PRIVATE_UPSTREAM_CIDRS = '127.0.0.0/8';
export const TEST_INSECURE_UPSTREAM_HOSTS = '127.0.0.1,localhost';
