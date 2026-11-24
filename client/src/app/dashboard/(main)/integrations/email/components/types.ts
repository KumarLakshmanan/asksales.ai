
export interface DnsRecord {
   record: string;
   name: string;
   type: string;
   ttl: string;
   status: string;
   value: string;
   priority?: number;
}

export interface ResendDomain {
   id: number;
   resendDomainId: string;
   name: string;
   status: string;
   region: string;
   dnsRecords: DnsRecord[];
   createdAt: string;
}

export interface GmailStatus {
   connected: boolean;
   email: string | null;
   accountName?: string;
   tokenExpired?: boolean;
   requiresReconnect?: boolean;
   connectionState?: 'connected' | 'disconnected' | 'reconnect_required' | 'rate_limited';
   cooldownUntil?: string | null;
   syncPending?: boolean;
   syncRetryAt?: string | null;
   syncFailures?: number;
   watchRenewalStatus?: string | null;
   watchRetryAt?: string | null;
   expiresAt?: string | null;
   hasConfig?: boolean;
   configSource?: "user" | "default" | "none";
   watchStatus?: 'active' | 'expiring_soon' | 'expired' | 'not_configured' | null;
   watchExpiresAt?: string | null;
}

export interface EmailSender {
   id: number;
   type: 'resend' | 'gmail';
   label: string;
   email: string;
   displayName: string | null;
   isDefault: boolean;
   isVerified: boolean;
   connectionActive?: boolean;
   createdAt: string;
}
