/** The inline error under a field: icon and the hidden word "Error:" so it never relies on colour alone. */
export function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} className="flex gap-2 text-sm text-red-800">
      <span aria-hidden="true" className="font-bold">
        !
      </span>
      <span>
        <span className="sr-only">Error:</span> {message}
      </span>
    </p>
  );
}

export function describedBy(
  id: string,
  parts: { hint?: string | undefined; error?: string | undefined },
): string | undefined {
  const ids = [parts.hint ? `${id}-hint` : '', parts.error ? `${id}-error` : ''].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}
