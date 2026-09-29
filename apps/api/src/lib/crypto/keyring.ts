/**
 * Keyring for the field-encryption module (architecture Q5). Keys come from `ENCRYPTION_KEYS`
 * (`<id>:<base64 32 bytes>[,...]`) and `ENCRYPTION_ACTIVE_KEY_ID`; the `KeyProvider` interface lets a
 * KMS-unwrapped data-key provider replace the env provider later without touching callers or the envelope.
 * Errors name variables and key ids only, never key material.
 */
import { parseEncryptionKeys, type KeyringEntry } from '../config/config.ts';

export interface KeyProvider {
  /** Id of the key used for new encryptions. */
  readonly activeKeyId: string;
  /** Key material for `keyId`, or `undefined` when that id is not in the keyring. */
  getKey(keyId: string): Buffer | undefined;
}

export class KeyringError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid encryption keyring: ${issues.join('; ')}`);
    this.name = 'KeyringError';
    this.issues = issues;
  }
}

export function createKeyProvider(
  entries: readonly KeyringEntry[],
  activeKeyId: string,
): KeyProvider {
  const keys = new Map(entries.map((entry) => [entry.id, entry.key]));
  const issues: string[] = [];
  for (const entry of entries) {
    if (entry.key.length !== 32) {
      issues.push(`key "${entry.id}" must be exactly 32 bytes`);
    }
  }
  if (!keys.has(activeKeyId)) {
    issues.push('ENCRYPTION_ACTIVE_KEY_ID does not match any id in ENCRYPTION_KEYS');
  }
  if (issues.length > 0) throw new KeyringError(issues);
  return { activeKeyId, getKey: (keyId) => keys.get(keyId) };
}

/** Builds the keyring from the loaded `Config` (`encryptionKeys`, `encryptionActiveKeyId`). */
export function keyProviderFromConfig(config: {
  readonly encryptionKeys: readonly KeyringEntry[];
  readonly encryptionActiveKeyId: string;
}): KeyProvider {
  return createKeyProvider(config.encryptionKeys, config.encryptionActiveKeyId);
}

/** Parses the raw environment variables with the same rules as `loadConfig`. */
export function keyProviderFromEnv(env: NodeJS.ProcessEnv = process.env): KeyProvider {
  const { keys, issues } = parseEncryptionKeys(env.ENCRYPTION_KEYS ?? '');
  if (issues.length > 0) {
    throw new KeyringError(issues.map((issue) => `ENCRYPTION_KEYS ${issue}`));
  }
  return createKeyProvider(keys, env.ENCRYPTION_ACTIVE_KEY_ID ?? '');
}
