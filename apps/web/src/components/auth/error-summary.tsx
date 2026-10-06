'use client';

import { useEffect, useRef } from 'react';
import type { FieldErrors } from '../../lib/auth/validation.ts';

/**
 * "There's a problem": takes focus when it appears (and when `focusToken` changes, one per failed
 * submit), links to every invalid field, and prefixes the page title with "Error: " while shown.
 */
export function ErrorSummary({
  errors,
  order,
  focusToken,
}: {
  errors: FieldErrors;
  /** Field names in form order; unknown names follow. */
  order: readonly string[];
  focusToken?: unknown;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const names = Object.keys(errors).sort((a, b) => rank(order, a) - rank(order, b));
  const visible = names.length > 0;

  useEffect(() => {
    if (visible) ref.current?.focus();
  }, [visible, focusToken]);

  useEffect(() => {
    if (!visible) return;
    const original = document.title;
    if (!original.startsWith('Error: ')) document.title = `Error: ${original}`;
    return () => {
      document.title = original;
    };
  }, [visible]);

  if (!visible) return null;
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="rounded-md border-2 border-red-800 bg-red-50 p-4 text-base"
    >
      <h2 className="text-lg font-semibold">There&apos;s a problem</h2>
      <ul className="mt-2 flex list-disc flex-col pl-5">
        {names.flatMap((name) =>
          (errors[name] ?? []).map((message) => (
            <li key={`${name}-${message}`}>
              <a
                href={`#field-${name}`}
                onClick={(event) => {
                  const target = document.getElementById(`field-${name}`);
                  if (target) {
                    event.preventDefault();
                    target.focus();
                  }
                }}
                className="inline-flex min-h-11 items-center text-red-900 underline"
              >
                {message}
              </a>
            </li>
          )),
        )}
      </ul>
    </div>
  );
}

function rank(order: readonly string[], name: string): number {
  const index = order.indexOf(name);
  return index === -1 ? order.length : index;
}
