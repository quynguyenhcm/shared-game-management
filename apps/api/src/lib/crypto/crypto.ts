/**
 * Application-level field encryption: AES-256-GCM via `node:crypto` (architecture Q5).
 *
 * Envelope (stored as TEXT): `v1.<keyId>.<iv_b64url(12B)>.<ciphertext_b64url>.<tag_b64url(16B)>`,
 * matching the CHECK constraints on the encrypted `teams` columns. AAD = `sgm:v1:<table>.<column>:<rowId>`,
 * so a ciphertext copied to another row or column fails authentication. Errors carry a reason code and a
 * fixed message only: never plaintext, ciphertext, key ids or key material.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  deriveBankAccountLast4 as sharedDeriveBankAccountLast4,
  type Ciphertext,
} from '@sgm/shared';
import type { KeyProvider } from './keyring.ts';

/** Same pattern as the `teams_*_envelope` CHECK constraints. */
export const ENVELOPE_PATTERN =
  /^v1\.[a-z0-9-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{22}$/;

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptionContext {
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
}

export type DecryptionFailure = 'unknown_key' | 'auth_failed' | 'malformed';

export class DecryptionError extends Error {
  readonly reason: DecryptionFailure;

  constructor(reason: DecryptionFailure) {
    super(`Decryption failed (${reason})`);
    this.name = 'DecryptionError';
    this.reason = reason;
  }
}

export interface FieldCrypto {
  encrypt(plaintext: string, context: EncryptionContext): Ciphertext;
  decrypt(ciphertext: string, context: EncryptionContext): string;
  /** True when the envelope was sealed with a key other than the active one. */
  needsRotation(ciphertext: string): boolean;
  /** Decrypts with whichever key sealed it and encrypts again with the active key. */
  reencrypt(ciphertext: string, context: EncryptionContext): Ciphertext;
}

function aadFor(context: EncryptionContext): Buffer {
  if (!context.table || !context.column || !context.rowId) {
    throw new TypeError('encryption context requires table, column and rowId');
  }
  return Buffer.from(`sgm:v1:${context.table}.${context.column}:${context.rowId}`, 'utf8');
}

function keyIdOf(envelope: string): string {
  if (typeof envelope !== 'string' || !ENVELOPE_PATTERN.test(envelope)) {
    throw new DecryptionError('malformed');
  }
  return envelope.split('.')[1] as string;
}

export function createCrypto(keys: KeyProvider): FieldCrypto {
  function encrypt(plaintext: string, context: EncryptionContext): Ciphertext {
    if (typeof plaintext !== 'string') throw new TypeError('plaintext must be a string');
    const aad = aadFor(context);
    const keyId = keys.activeKeyId;
    const key = keys.getKey(keyId);
    if (key === undefined) throw new TypeError('active encryption key is not available');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      keyId,
      iv.toString('base64url'),
      body.toString('base64url'),
      tag.toString('base64url'),
    ].join('.') as Ciphertext;
  }

  function decrypt(ciphertext: string, context: EncryptionContext): string {
    const keyId = keyIdOf(ciphertext);
    const aad = aadFor(context);
    const key = keys.getKey(keyId);
    if (key === undefined) throw new DecryptionError('unknown_key');
    const [, , ivPart = '', bodyPart = '', tagPart = ''] = ciphertext.split('.');
    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(bodyPart, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Deliberately drop the underlying error: it must not travel with (or log) any payload.
      throw new DecryptionError('auth_failed');
    }
  }

  return {
    encrypt,
    decrypt,
    needsRotation: (ciphertext) => keyIdOf(ciphertext) !== keys.activeKeyId,
    reencrypt: (ciphertext, context) => encrypt(decrypt(ciphertext, context), context),
  };
}

/**
 * Plaintext display projection stored in `teams.bank_account_last4` beside the encrypted number: the last 4
 * digits of the account base, not the suffix (R9). The rule lives in `@sgm/shared` beside the validator.
 */
export function deriveBankAccountLast4(accountNumber: string): string {
  return sharedDeriveBankAccountLast4(accountNumber);
}
