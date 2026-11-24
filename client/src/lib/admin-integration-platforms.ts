export interface PlatformConfig {
  platformName: string;
  color: string;
  description: string;
  features: string[];
  keyFieldLabel?: string;
  keyFieldPlaceholder?: string;
  showSecretField?: boolean;
  secretFieldLabel?: string;
  secretFieldPlaceholder?: string;
  showModelField?: boolean;
  modelPlaceholder?: string;
  modelOptions?: { value: string; label: string }[];
  showValidate?: boolean;
  secretRequired?: boolean;
  /** Show chunk size & overlap configuration (embedding platforms only) */
  showChunkConfig?: boolean;
  /** Show Google Cloud region configuration (Vertex AI only). */
  showLocationField?: boolean;
}

export const PLATFORM_CONFIGS: Record<string, PlatformConfig> = {
  openai: {
    platformName: "OpenAI",
    color: "bg-emerald-500",
    description: "GPT models for AI chat, content generation, and automation",
    features: ["AI Chat", "Content Generation", "Lead Scoring", "Email Writing"],
    keyFieldLabel: "API Key",
    keyFieldPlaceholder: "sk-...",
    showModelField: true,
    modelPlaceholder: "Select default model",
    modelOptions: [
      { value: "gpt-4o", label: "GPT-4o" },
      { value: "gpt-4o-mini", label: "GPT-4o Mini" },
      { value: "gpt-4-turbo", label: "GPT-4 Turbo" },
      { value: "gpt-4", label: "GPT-4" },
      { value: "gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
    ],
    showValidate: true,
  },
  gemini: {
    platformName: "Gemini Developer API",
    color: "bg-blue-500",
    description: "Google AI Studio / Gemini Developer API for chat, content generation, and tool calling",
    features: ["AI Studio", "API Key", "Tool Calling", "Multimodal"],
    keyFieldLabel: "API Key",
    keyFieldPlaceholder: "AIza...",
    showModelField: true,
    modelPlaceholder: "Select default model",
    modelOptions: [
      { value: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
      { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
      { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
      { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    ],
    showValidate: true,
  },
  vertex_ai: {
    platformName: "Google Cloud Vertex AI",
    color: "bg-sky-700",
    description: "Enterprise Gemini access through a Google Cloud project and service account",
    features: ["Google Cloud", "Service Account", "Regional Processing", "Tool Calling"],
    keyFieldLabel: "Service Account JSON",
    keyFieldPlaceholder: '{"type":"service_account","project_id":"..."}',
    showModelField: true,
    showLocationField: true,
    modelPlaceholder: "Select default Vertex AI model",
    modelOptions: [
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
      { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
    ],
    showValidate: true,
  },
  gemini_image: {
    platformName: "Gemini Image",
    color: "bg-indigo-500",
    description: "Gemini & Vertex AI key for AI image generation",
    features: ["Image Generation", "Image-to-Image", "Gemini API", "Vertex AI"],
    keyFieldLabel: "API Key",
    keyFieldPlaceholder: "AIza...",
    showSecretField: true,
    secretRequired: false,
    secretFieldLabel: "Project ID (Vertex AI only, optional)",
    secretFieldPlaceholder: "my-gcp-project-id",
    showModelField: true,
    modelPlaceholder: "Select image model",
    modelOptions: [
      { value: "gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image" },
    ],
    showValidate: false,
  },
  gemini_video: {
    platformName: "Gemini Video",
    color: "bg-violet-500",
    description: "Gemini & Vertex AI key for AI video generation",
    features: ["Video Generation", "Image-to-Video", "Gemini API", "Vertex AI"],
    keyFieldLabel: "API Key",
    keyFieldPlaceholder: "AIza...",
    showSecretField: true,
    secretRequired: false,
    secretFieldLabel: "Project ID (Vertex AI only, optional)",
    secretFieldPlaceholder: "my-gcp-project-id",
    showModelField: true,
    modelPlaceholder: "Select video model",
    modelOptions: [
      { value: "veo-3.1-fast-generate-001", label: "Veo 3.1 Fast" },
      { value: "veo-3.1-generate-001", label: "Veo 3.1" },
      { value: "veo-2.0-generate-001", label: "Veo 2.0" },
    ],
    showValidate: false,
  },
  openrouter: {
    platformName: "OpenRouter",
    color: "bg-purple-500",
    description: "Unified access to text, image, and video models from multiple providers",
    features: ["Multi-Model Access", "Seedream Images", "Seedance Videos", "Claude", "GPT"],
    keyFieldLabel: "API Key",
    keyFieldPlaceholder: "sk-or-...",
    showModelField: true,
    modelPlaceholder: "Select default model",
    modelOptions: [
      { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
      { value: "meta-llama/llama-3.1-405b-instruct", label: "Llama 3.1 405B" },
      { value: "meta-llama/llama-3.1-70b-instruct", label: "Llama 3.1 70B" },
      { value: "meta-llama/llama-3.1-8b-instruct", label: "Llama 3.1 8B" },
      { value: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
      { value: "anthropic/claude-3-haiku", label: "Claude 3 Haiku" },
      { value: "google/gemini-pro-1.5", label: "Gemini Pro 1.5" },
      { value: "google/gemini-flash-1.5", label: "Gemini Flash 1.5" },
      { value: "mistralai/mistral-large", label: "Mistral Large" },
      { value: "mistralai/mixtral-8x7b-instruct", label: "Mixtral 8x7B" },
      { value: "openai/gpt-4o", label: "GPT-4o" },
      { value: "openai/gpt-4-turbo", label: "GPT-4 Turbo" },
      { value: "openai/gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
    ],
    showValidate: true,
  },
  zerobounce: {
    platformName: "ZeroBounce",
    color: "bg-cyan-500",
    description: "Email validation and verification service",
    features: ["Email Validation", "Bounce Prevention", "Deliverability"],
    keyFieldLabel: "API Key",
    keyFieldPlaceholder: "Enter your ZeroBounce API key",
    showValidate: true,
  },
  razorpay: {
    platformName: "Razorpay",
    color: "bg-blue-600",
    description: "Payment gateway for wallet recharges and wallet top-ups",
    features: ["Wallet Recharge", "UPI / Cards", "NetBanking", "Payment Verification"],
    keyFieldLabel: "Key ID",
    keyFieldPlaceholder: "rzp_live_xxxxxxxxxxxxx",
    showSecretField: true,
    secretFieldLabel: "Key Secret",
    secretFieldPlaceholder: "Enter your Razorpay Key Secret",
    showValidate: false,
  },
  custom_ai: {
    platformName: "Custom AI",
    color: "bg-amber-500",
    description: "Connect your own OpenAI-compatible API endpoint",
    features: ["Custom Endpoint", "Any Model", "Self-Hosted"],
    keyFieldLabel: "API Key",
    keyFieldPlaceholder: "Enter your API key",
    showModelField: true,
    modelPlaceholder: "Enter model name",
    showValidate: true,
  },
  openai_embedding: {
    platformName: "OpenAI Embedding",
    color: "bg-emerald-500",
    description: "OpenAI embedding models for semantic search and RAG",
    features: ["text-embedding-3-small (1536d)", "text-embedding-3-large (3072d)"],
    keyFieldLabel: "API Key",
    keyFieldPlaceholder: "sk-...",
    showModelField: true,
    modelPlaceholder: "Select or type an embedding model",
    modelOptions: [
      { value: "text-embedding-3-small", label: "text-embedding-3-small (1536d)" },
      { value: "text-embedding-3-large", label: "text-embedding-3-large (3072d)" },
    ],
    showValidate: true,
    showChunkConfig: true,
  },
  openrouter_embedding: {
    platformName: "OpenRouter Embedding",
    color: "bg-purple-500",
    description: "Embedding models through OpenRouter for semantic search and RAG",
    features: ["OpenAI embeddings", "Gemini embeddings", "OpenRouter model IDs"],
    keyFieldLabel: "API Key",
    keyFieldPlaceholder: "sk-or-...",
    showModelField: true,
    modelPlaceholder: "Select or enter a provider/model embedding ID",
    modelOptions: [
      { value: "openai/text-embedding-3-small", label: "OpenAI small (1536d)" },
      { value: "openai/text-embedding-3-large", label: "OpenAI large (3072d)" },
      { value: "google/gemini-embedding-001", label: "Gemini embedding (768d)" },
    ],
    showValidate: true,
    showChunkConfig: true,
  },
  gemini_embedding: {
    platformName: "Gemini Embedding",
    color: "bg-blue-500",
    description: "Google Gemini embedding models for semantic search and RAG",
    features: ["gemini-embedding-001 (768d)"],
    keyFieldLabel: "API Key",
    keyFieldPlaceholder: "AIza...",
    showModelField: true,
    modelPlaceholder: "Select or type an embedding model",
    modelOptions: [
      { value: "gemini-embedding-001", label: "gemini-embedding-001 (768d)" },
    ],
    showValidate: true,
    showChunkConfig: true,
  },
};
