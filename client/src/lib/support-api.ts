import { createApiClient } from "./api-client";

export { ApiError, buildApiUrl } from "./api-client";
export type { ApiOptions } from "./api-client";

export const supportApi = createApiClient({
  tokenStorageKey: "support_token",
  profileStorageKeys: ["support_member"],
  unauthorizedEvent: "support:unauthorized",
});

export default supportApi;
