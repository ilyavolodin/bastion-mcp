import { hash, verify } from '@node-rs/argon2';

/** 22.3: argon2id, 64 MiB, 3 iterations. Verification inside argon2 compares in constant time. */
export const ARGON2_OPTIONS = {
  algorithm: 2, // Argon2id
  memoryCost: 64 * 1024, // KiB
  timeCost: 3,
  parallelism: 1,
} as const;

export const hashPassword = (password: string): Promise<string> => hash(password, ARGON2_OPTIONS);

/** False for a wrong password or a malformed hash; never throws on bad input. */
export const verifyPassword = async (storedHash: string, password: string): Promise<boolean> => {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
};
