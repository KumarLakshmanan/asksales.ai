export interface AdminDirectoryLead {
  id: number;
  userId: number | null;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  companyName: string | null;
  jobTitle: string | null;
  source: string;
  status: string;
  score: number;
  createdAt: string | Date;
  userName: string | null;
  userEmail: string | null;
}
export interface AdminLeadDirectoryResponse {
  items: AdminDirectoryLead[];
  pagination: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
  stats: {
    totalLeads: number;
    active: number;
    converted: number;
    qualified: number;
    contacted: number;
    conversionRate: number;
  };
  filters: { statuses: string[]; sources: string[] };
}
