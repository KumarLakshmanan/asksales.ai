export class AssistantManagementError extends Error {
  constructor(message: string, public status = 400, public details?: unknown) {
    super(message);
  }
}
