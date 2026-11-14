/**
 * `Content-Disposition` for file downloads (RFC 6266, RFC 5987; tax-invoices-and-exports architecture Decision 4). The header is
 * always `attachment`, so a browser saves the bytes and never renders them, and the file name is made safe in two steps:
 *
 *   - `asciiFilename` keeps `[A-Za-z0-9._-]` (letters lose their diacritics first, so `Hōkio` becomes `Hokio`), turns every
 *     other run into one `-`, and is never empty, never starts with a dot and never contains a path separator or a quote, so
 *     the name cannot inject a header parameter, escape the download directory or hide the extension;
 *   - `attachmentDisposition` writes that ASCII `filename="..."` and, when the wanted name differs, the UTF-8 `filename*=` form
 *     (percent-encoded per RFC 5987) for clients that understand it.
 *
 * Pure. No sensitive text belongs in a file name: callers pass a document number or a team slug, never a payer name.
 */

const FALLBACK_NAME = 'download';

/** A UTF-16 surrogate with no partner: `encodeURIComponent` would throw on it. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** An ASCII-only, path-free file name from arbitrary text. `maxLength` counts characters of the base name (default 120). */
export function asciiFilename(name: string, maxLength = 120): string {
  const dot = name.lastIndexOf('.');
  const hasExtension = dot > 0 && dot >= name.length - 6;
  const base = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot + 1) : '';
  const clean = (text: string): string =>
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[.-]+|[.-]+$/g, '');
  const safeBase = clean(base).slice(0, maxLength) || FALLBACK_NAME;
  const safeExtension = clean(extension).slice(0, 8);
  return safeExtension === '' ? safeBase : `${safeBase}.${safeExtension}`;
}

/** RFC 5987 `attr-char` percent-encoding of a UTF-8 value. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `attachment; filename="<ascii>"` plus `filename*=UTF-8''<encoded>` when the wanted name is not already that ASCII name. */
export function attachmentDisposition(wanted: string): string {
  const ascii = asciiFilename(wanted);
  return ascii === wanted
    ? `attachment; filename="${ascii}"`
    : `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(wanted.replace(LONE_SURROGATE, '\ufffd').replace(/[\r\n"\\/]/g, '-'))}`;
}
