import { cloneElement, isValidElement, useId, useState, type ReactElement, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Callout } from '@/components/ui/callout';
import { cn } from '@/lib/utils';

export const selectClass =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
export function Section({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-xl border bg-card p-5 sm:p-6', className)}>
      <h2 className="font-semibold tracking-tight">{title}</h2>
      {description && <p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p>}
      <div className="mt-5 space-y-4">{children}</div>
    </section>
  );
}
export function Field({
  label,
  hint,
  children,
  error,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  error?: string;
}) {
  const controlId = useId();
  const descriptionId = `${controlId}-description`;
  const control = isValidElement(children) ? cloneElement(children as ReactElement<Record<string, unknown>>, { id: controlId, 'aria-invalid': !!error, 'aria-describedby': error || hint ? descriptionId : undefined }) : children;
  return (
    <div className="space-y-2">
      <label htmlFor={controlId} className="block text-sm font-medium">{label}</label>
      {control}
      {(error || hint) && <p id={descriptionId} className={cn('text-xs leading-5', error ? 'text-destructive' : 'text-muted-foreground')}>{error || hint}</p>}
    </div>
  );
}
export function Errors({ errors }: { errors: string[] }) {
  return errors.length ? (
    <Callout tone="danger" tabIndex={-1}>
      <ul className="list-inside list-disc space-y-1">
        {errors.map((error, i) => (
          <li key={i}>{error}</li>
        ))}
      </ul>
    </Callout>
  ) : null;
}
export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-5">
      <label htmlFor={id} className="cursor-pointer text-sm">
        <span className="font-medium">{label}</span>
        {hint && (
          <span className="mt-1 block max-w-xl text-xs leading-5 text-muted-foreground">
            {hint}
          </span>
        )}
      </label>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="mt-1 h-4 w-4 shrink-0 accent-primary"
      />
    </div>
  );
}
export function TokenInput({
  label,
  value,
  onChange,
  hint,
  max = 20,
  placeholder = 'Type a word, then press Enter',
  error,
}: {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  hint?: string;
  max?: number;
  placeholder?: string;
  error?: string;
}) {
  const [input, setInput] = useState('');
  const pendingValue = input.trim() && value.length < max && !value.some(item => item.toLowerCase() === input.trim().toLowerCase()) ? input.trim() : '';
  const add = () => {
    const next = input.trim();
    if (
      next &&
      value.length < max &&
      !value.some((item) => item.toLowerCase() === next.toLowerCase())
    )
      onChange([...value, next]);
    setInput('');
  };
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Field label={label} hint={hint} error={error}>
            <Input
              aria-label={label}
              maxLength={80}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onBlur={add}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder={placeholder}
              disabled={value.length >= max}
            />
          </Field>
        </div>
        <Button
          className="mt-7"
          aria-label={`Add ${label.toLowerCase()}`}
          type="button"
          variant="outline"
          disabled={!input.trim() || value.length >= max}
          onClick={add}
        >
          <Plus className="h-4 w-4" />
          Add
        </Button>
      </div>
      <div className="flex min-h-8 flex-wrap gap-2">
        {value.map((item) => (
          <span
            key={item}
            className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/60 py-1 pl-2.5 pr-1 text-xs"
          >
            <span className="min-w-0 truncate" title={item}>{item}</span>
            <button
              type="button"
              aria-label={`Remove ${item}`}
              className="shrink-0 rounded p-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onChange(value.filter((v) => v !== item))}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {/* Reserve the pending chip's space before blur so the clicked control stays under the pointer. */}
        {pendingValue && <span aria-hidden="true" className="pointer-events-none invisible inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/60 py-1 pl-2.5 pr-1 text-xs"><span className="min-w-0 truncate">{pendingValue}</span><span className="shrink-0 rounded p-1"><X className="h-3 w-3" /></span></span>}
      </div>
      <p className="text-xs text-muted-foreground">
        {value.length} / {max}
      </p>
    </div>
  );
}
