/** Longest address the database accepts (`users_email_normalised`) and RFC 5321 allows. */
export const EMAIL_MAX_LENGTH = 254;

const LOCAL_MAX_LENGTH = 64;
const DOMAIN_MAX_LENGTH = 253;
/** ASCII printable without space and `@` (0x21-0x7E minus 0x40): the database CHECK character class. */
const LOCAL_PATTERN = /^[!-?A-~]+$/;
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
}

/** Characters that would change how `URL` parses a host; rejected before the punycode conversion. */
function isHostUnsafe(domain: string): boolean {
  return /[\s/\\?#@:[\]%]/.test(domain) || [...domain].some((char) => isControl(char));
}

/** Domain to lowercase ASCII (punycode for IDN), or null. `URL` is the same IDNA code path in Node and browsers. */
function toAsciiDomain(domain: string): string | null {
  if (domain === '' || isHostUnsafe(domain)) return null;
  let host: string;
  try {
    host = new URL(`http://${domain}`).hostname;
  } catch {
    return null;
  }
  if (host === '' || host.length > DOMAIN_MAX_LENGTH) return null;
  const labels = host.split('.');
  // At least two labels, valid LDH labels, and a TLD that is not all digits (rules out IPv4-like hosts).
  if (labels.length < 2 || !labels.every((label) => LABEL_PATTERN.test(label))) return null;
  if (/^[0-9]+$/.test(labels[labels.length - 1] ?? '')) return null;
  return host;
}

/**
 * The one email normal form (algorithm S1-b), used by the web and the API: trim, NFC, split at the last
 * `@`, ASCII-only local part lowercased, domain converted to lowercase punycode, at most 254 characters.
 * The stored value is pure ASCII, so the database CHECK (`lower(email) = email`) is exact in any collation.
 * Returns null when the input is not a usable address.
 */
export function normaliseEmail(raw: string): string | null {
  const value = raw.trim().normalize('NFC');
  if (value === '' || value.length > EMAIL_MAX_LENGTH * 2) return null;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  const local = value.slice(0, at);
  if (local.length > LOCAL_MAX_LENGTH || !LOCAL_PATTERN.test(local)) return null;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  const domain = toAsciiDomain(value.slice(at + 1));
  if (domain === null) return null;
  const email = `${local.toLowerCase()}@${domain}`;
  return email.length <= EMAIL_MAX_LENGTH ? email : null;
}
