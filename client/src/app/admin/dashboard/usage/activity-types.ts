/** A recent LLM call on the Gemini and OpenRouter usage pages. */
export interface LlmRecentActivity {
  id: number;
  model?: string;
  tokens?: number | null;
  cost?: number | null;
  latency?: number;
  purpose?: string;
  userName?: string;
  user_name?: string;
  createdAt?: string;
  created_at?: string;
}

/** A recent media generation on the Gemini image and video usage pages. */
export interface MediaRecentActivity {
  id: number;
  model?: string;
  tokens?: number | null;
  cost?: number | null;
  purpose?: string;
  userName?: string;
  userEmail?: string;
  createdAt?: string;
}
