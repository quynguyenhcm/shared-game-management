import { FieldError, describedBy } from './field-message.tsx';
import { INPUT_CLASS } from './styles.ts';

export interface TextFieldProps {
  name: string;
  label: string;
  type?: 'text' | 'email';
  hint?: string;
  error?: string;
  defaultValue?: string;
  autoComplete?: string;
  autoCapitalize?: 'none' | 'words';
  /** Virtual keyboard for the field (the banking and GST numbers ask for the numeric one, an amount the decimal one). */
  inputMode?: 'numeric' | 'decimal' | 'text';
  spellCheck?: boolean;
  /** The virtual keyboard's action key (an amount field that submits says "go"). */
  enterKeyHint?: 'go' | 'done' | 'next';
}

/** A labelled input whose hint and error are tied to it with `aria-describedby`; id is `field-<name>`. */
export function TextField({
  name,
  label,
  type = 'text',
  hint,
  error,
  defaultValue,
  autoComplete,
  autoCapitalize,
  inputMode,
  spellCheck,
  enterKeyHint,
}: TextFieldProps) {
  const id = `field-${name}`;
  const isEmail = type === 'email';
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-base font-medium">
        {label}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-slate-700">
          {hint}
        </p>
      ) : null}
      {error ? <FieldError id={`${id}-error`} message={error} /> : null}
      <input
        id={id}
        name={name}
        type={type}
        defaultValue={defaultValue}
        autoComplete={autoComplete}
        autoCapitalize={autoCapitalize ?? (isEmail ? 'none' : undefined)}
        autoCorrect={isEmail ? 'off' : undefined}
        spellCheck={spellCheck ?? (isEmail ? false : undefined)}
        inputMode={inputMode ?? (isEmail ? 'email' : undefined)}
        enterKeyHint={enterKeyHint}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, { hint, error })}
        className={INPUT_CLASS}
      />
    </div>
  );
}
