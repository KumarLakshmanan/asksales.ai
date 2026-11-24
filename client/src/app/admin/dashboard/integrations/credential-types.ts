/** An admin API credential row as listed on the integration pages. */
export interface AdminProviderCredential {
  id: number;
  platform: string;
  name: string;
  apiKey: string;
  apiSecret?: string;
  isActive: boolean;
  priority: string;
  config?: Record<string, unknown>;
  lastUsedAt?: string;
  usageCount?: string;
  deactivationReason?: string;
  validationStatus?: string | null;
  validationMessage?: string | null;
  createdAt: string;
}
