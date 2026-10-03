import { RegistryInvalidResponseError } from './errors';

/** Default cap for registry and package-index responses. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Reads a response body as text, refusing more than `maxBytes`: a declared `content-length` above the cap is
 * refused before reading, and a stream without one is cancelled as soon as the cap is crossed.
 */
export const readBodyCapped = async (response: Response, maxBytes: number): Promise<string> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new RegistryInvalidResponseError('registry response too large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RegistryInvalidResponseError('registry response too large');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
};
