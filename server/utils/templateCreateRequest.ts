export interface TemplateCreateRequest { key: string; hash: string }
export class TemplateCreateRequestError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) { super(message); }
}
