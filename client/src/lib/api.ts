import { createApiClient } from "./api-client";

export { ApiError, buildApiUrl } from "./api-client";
export type { ApiOptions } from "./api-client";

export const api = createApiClient({
  tokenStorageKey: "token",
  profileStorageKeys: ["user"],
  unauthorizedEvent: "auth:unauthorized",
  unauthorizedMessage: "Unauthorized - redirecting to login",
});

export default api;
