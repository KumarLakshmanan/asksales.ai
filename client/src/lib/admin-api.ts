import { createApiClient } from "./api-client";

export { ApiError, buildApiUrl } from "./api-client";
export type { ApiOptions } from "./api-client";

export const api = createApiClient({
  tokenStorageKey: "admin_token",
  profileStorageKeys: ["admin"],
  unauthorizedEvent: "admin:unauthorized",
});

export default api;
