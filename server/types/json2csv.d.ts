/**
 * Type declarations for `json2csv` v6.x.
 *
 * Phase 6.11 / TYPE-003: the v6 release split the previously default-
 * exported `parse`/`Formatter`/`Flat` helpers into named exports. The
 * previous `declare module 'json2csv';` (which inferred `any`) silently
 * allowed `json2csv.parse(...)` to type-check, but only because the entire
 * module was `any`. This declaration surfaces the real types so the
 * `fields` option, return value, and `parseAsync` overload are all
 * checked.
 */
declare module 'json2csv' {
  export interface FieldValueFormatter<T> {
    (value: T, fieldHeader: string): string;
  }

  export interface FieldInfo<T> {
    label?: string;
    value: keyof T | string;
    default?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    formatter?: FieldValueFormatter<any>;
  }

  export type Field<T> = (keyof T & string) | FieldInfo<T>;

  export interface ParseOptions<T = Record<string, unknown>> {
    fields?: Field<T>[];
    header?: boolean;
    delimiter?: string;
    quote?: string;
    escapedQuote?: string;
    newline?: string;
    excelStrings?: boolean;
    withQuote?: boolean;
  }

  export interface ParseResult {
    data: string;
  }

  export function parse<T = Record<string, unknown>>(
    data: T[] | T,
    options?: ParseOptions<T>
  ): string;
  export function parse<T = Record<string, unknown>>(
    data: T[] | T,
    options: ParseOptions<T> & { to: string }
  ): never;

  export function parseAsync<T = Record<string, unknown>>(
    data: T[] | T,
    options?: ParseOptions<T>
  ): Promise<string>;

  export class Parser<T = Record<string, unknown>> {
    constructor(opts?: ParseOptions<T>);
    parse(data: T[] | T): string;
    parseAsync(data: T[] | T): Promise<string>;
  }

  export class Transform {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(opts?: ParseOptions<any>);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parse(data: any): string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parseAsync(data: any): Promise<string>;
  }

  export const Formatter: typeof Transform;

  const _default: {
    parse: typeof parse;
    parseAsync: typeof parseAsync;
    Parser: typeof Parser;
    Transform: typeof Transform;
    Formatter: typeof Formatter;
  };
  export default _default;
}
