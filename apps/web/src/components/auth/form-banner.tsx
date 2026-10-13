'use client';

import { useEffect, useRef } from 'react';
import type { ErrorLink } from '../../lib/auth/landing.ts';
import { LINK_CLASS } from './styles.ts';

/**
 * A notice (`role="status"`, never takes focus) or an error (`role="alert"`, focused once when it
 * appears and again whenever `focusToken` changes, i.e. on each new server result).
 */
export function FormBanner({
  kind,
  lines,
  links = [],
  focusToken,
}: {
  kind: 'notice' | 'error';
  lines: readonly string[];
  links?: readonly ErrorLink[];
  focusToken?: unknown;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isError = kind === 'error';

  useEffect(() => {
    if (isError) ref.current?.focus();
  }, [isError, focusToken]);

  return (
    <div
      ref={ref}
      role={isError ? 'alert' : 'status'}
      tabIndex={-1}
      className={`rounded-md border-2 p-4 text-base ${
        isError ? 'border-red-800 bg-red-50' : 'border-blue-800 bg-blue-50'
      }`}
    >
      {lines.map((line, index) => (
        <p key={line} className={index === 0 ? 'font-medium' : 'mt-1'}>
          {index === 0 && isError ? <span className="sr-only">Error: </span> : null}
          {line}
        </p>
      ))}
      {links.length > 0 ? (
        <p className="mt-2 flex flex-wrap gap-x-4">
          {links.map((link) => (
            <a key={link.href} href={link.href} className={LINK_CLASS}>
              {link.label}
            </a>
          ))}
        </p>
      ) : null}
    </div>
  );
}
