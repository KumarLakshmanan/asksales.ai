if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');
import { executeGenerateSocialMediaPost } from '../mastra/tools/executors/contentExecutor';
import { executeGenerateAd } from '../mastra/tools/executors/adsExecutor';
import { LLMProviderFactory } from '../services/agents/LLMProviderFactory';

// 1. MOCK LLMProviderFactory to bypass the database lookup
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(LLMProviderFactory as any).getAdminCredentials = async function() {
  return {
    openai: null,
    openrouter: null,
    custom_ai: null,
    gemini: {
      id: 1,
      apiKey: process.env.GEMINI_API_KEY || '',
      model: 'gemini-1.5-flash-latest'
    },
    gemini_image: {
      id: 2,
      apiKey: process.env.GEMINI_API_KEY || '',
      model: 'gemini-3-pro-image-001'
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
(LLMProviderFactory as any).createProviderForUser = async function(userId: number) {
  const { GeminiProvider } = await import('../services/agents/GeminiProvider');
  
  // Here we use Gemini Flash for fast testing
  const provider = new GeminiProvider(
    process.env.GEMINI_API_KEY || '',
    'gemini-1.5-flash-latest'
  );
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any)._platform = 'gemini';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any)._isAdmin = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return provider as any;
};

async function runTest() {
  console.log("=== Testing Social Media Post Generation ===");
  try {
    const socialResult = await executeGenerateSocialMediaPost(
      {
        topic: "A new AI assistant tool that automates digital marketing workflows",
        platform: "instagram",
        tone: "professional",
        auto_generate_image: true,
        auto_generate_video: false,
        image_count: 2
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      {
        userId: 1,
        threadId: 9999,
        icpProfile: { target: "small business owners" }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
    );
    console.log("\n[Social Post Result] Images generated:", socialResult.output?.generatedImages?.length || 0);
    console.log(JSON.stringify(socialResult, null, 2));
  } catch (e) {
    console.error("Social Post Error:", e);
  }

  console.log("\n=== Testing Ad Copy Generation ===");
  try {
    const adResult = await executeGenerateAd(
      {
        objective: "leads",
        platform: "meta",
        ad_format: "image",
        tone: "informative",
        language: "English",
        cta_type: "sign_up",
        include_image_prompt: true,
        auto_generate_image: false,
      },
      {
        userId: 1,
        threadId: 9999,
        icpProfile: { targetAudience: "digital marketers" }
      }
    );
    console.log("\n[Ad Copy Result] Images generated:", adResult.output?.generatedImages?.length || 0);
    console.log(JSON.stringify(adResult, null, 2));
  } catch (e) {
    console.error("Ad Copy Error:", e);
  }

  process.exit(0);
}

runTest();
