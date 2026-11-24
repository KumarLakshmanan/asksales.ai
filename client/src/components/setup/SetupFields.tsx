"use client";

import { useId, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export function SetupField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  multiline,
  type = "text",
  required,
  maxLength,
  min,
  max,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  multiline?: boolean;
  type?: string;
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
}) {
  const id = useId();
  return (
    <div className="setup-field">
      <label htmlFor={id}>
        {label}
        {required && <span className="text-primary"> *</span>}
      </label>
      {hint && <p id={`${id}-hint`}>{hint}</p>}
      {multiline ? (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          required={required}
          aria-describedby={hint ? `${id}-hint` : undefined}
          rows={4}
        />
      ) : (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          type={type}
          placeholder={placeholder}
          maxLength={maxLength}
          min={min}
          max={max}
          required={required}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
      )}
    </div>
  );
}

export function SetupChoices({
  label,
  hint,
  options,
  selected,
  onSelect,
  required,
}: {
  label: string;
  hint?: string;
  options: { label: string; value: string }[];
  selected: string[];
  onSelect: (value: string) => void;
  required?: boolean;
}) {
  return (
    <fieldset className="setup-field">
      <legend>
        {label}
        {required && <span className="text-primary"> *</span>}
      </legend>
      {hint && <p>{hint}</p>}
      <div className="setup-choice-grid">
        {options.map((option) => (
          <button
            type="button"
            key={option.value}
            aria-pressed={selected.includes(option.value)}
            onClick={() => onSelect(option.value)}
          >
            <span>{option.label}</span>
            {selected.includes(option.value) && <Check size={14} />}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function SetupTags({
  label,
  hint,
  value,
  onChange,
  suggestions = [],
  hashtag = false,
}: {
  label: string;
  hint?: string;
  value: string[];
  onChange: (value: string[]) => void;
  suggestions?: string[];
  hashtag?: boolean;
}) {
  const id = useId();
  const [input, setInput] = useState("");
  const add = () => {
    const clean = input.trim();
    if (!clean) return;
    const item = hashtag && !clean.startsWith("#") ? `#${clean}` : clean;
    if (!value.some((v) => v.toLowerCase() === item.toLowerCase()))
      onChange([...value, item]);
    setInput("");
  };
  return (
    <div className="setup-field">
      <label htmlFor={id}>{label}</label>
      {hint && <p id={`${id}-hint`}>{hint}</p>}
      <div className="flex gap-2">
        <Input
          id={id}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Type and press Enter"
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Add ${label.toLowerCase()}`}
          onClick={add}
        >
          <Plus size={16} />
        </Button>
      </div>
      {value.length > 0 && (
        <ul className="setup-tags">
          {value.map((item) => (
            <li key={item}>
              {item}
              <button
                type="button"
                aria-label={`Remove ${item}`}
                onClick={() => onChange(value.filter((v) => v !== item))}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {suggestions.some((item) => !value.includes(item)) && (
        <div className="setup-suggestions">
          {suggestions
            .filter((item) => !value.includes(item))
            .map((item) => (
              <button
                type="button"
                key={item}
                onClick={() => onChange([...value, item])}
              >
                + {item}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

export const choiceOptions = (values: string[]) =>
  [...new Set(values)].map((value) => ({ label: value, value }));

export function isOptionalWebUrl(value: string) {
  if (!value.trim()) return true;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
