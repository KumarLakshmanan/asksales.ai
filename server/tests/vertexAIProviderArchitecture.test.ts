import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  normalizeVertexLocation,
  parseVertexServiceAccountJson,
} from '../utils/vertexAuth.js';
import { toMastraModel } from '../mastra/utils/modelConfig.js';

const serviceAccount = JSON.stringify({
  type: 'service_account',
  project_id: 'asksales-vertex-prod',
  private_key_id: 'key-id',
  private_key: '-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n',
  client_email: 'asksales-runtime@asksales-vertex-prod.iam.gserviceaccount.com',
  client_id: '123456789',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/test',
});

describe('Vertex AI provider architecture', () => {
  it('validates Google Cloud service-account identity and regions', () => {
    expect(parseVertexServiceAccountJson(serviceAccount)).toMatchObject({
      type: 'service_account',
      project_id: 'asksales-vertex-prod',
      client_email: 'asksales-runtime@asksales-vertex-prod.iam.gserviceaccount.com',
    });
    expect(normalizeVertexLocation(undefined)).toBe('us-central1');
    expect(normalizeVertexLocation('asia-south1')).toBe('asia-south1');
    expect(normalizeVertexLocation('global')).toBe('global');
    expect(() => normalizeVertexLocation('https://example.com')).toThrow('location');
    expect(() => parseVertexServiceAccountJson('{"type":"service_account"}')).toThrow('missing');
  });

  it('routes Mastra through the official Vertex OpenAI-compatible endpoint contract', () => {
    expect(toMastraModel({
      provider: 'vertex_ai',
      apiKey: 'short-lived-oauth-token',
      modelName: 'gemini-2.5-flash',
      baseURL: 'https://aiplatform.googleapis.com/v1/projects/project/locations/global/endpoints/openapi',
    })).toEqual({
      providerId: 'vertex-ai',
      modelId: 'google/gemini-2.5-flash',
      url: 'https://aiplatform.googleapis.com/v1/projects/project/locations/global/endpoints/openapi',
      apiKey: 'short-lived-oauth-token',
    });
  });

  it('uses the Vertex SDK mode and never the Gemini Developer API endpoint', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'services/agents/VertexAIProvider.ts'),
      'utf8',
    );
    expect(source).toContain('vertexai: true');
    expect(source).toContain('https://www.googleapis.com/auth/cloud-platform');
    expect(source).not.toContain('generativelanguage.googleapis.com');
  });

  it('keeps Vertex AI available to shared generation and fail-closed moderation', () => {
    const factory = fs.readFileSync(
      path.resolve(process.cwd(), 'services/agents/LLMProviderFactory.ts'),
      'utf8',
    );
    const moderation = fs.readFileSync(
      path.resolve(process.cwd(), 'services/agents/orchestration/ContentModerationService.ts'),
      'utf8',
    );
    expect(factory).toContain("getActiveAdminCredential('vertex_ai')");
    expect(factory).toContain("['openai', 'vertex_ai', 'gemini', 'openrouter', 'custom_ai']");
    expect(moderation).toContain("getAllActiveAdminCredentials('vertex_ai')");
    expect(moderation).toContain("source: 'vertex_ai'");
  });

  it('routes support classification, sentiment, presentation, and reranking through shared fallback', () => {
    const supportFallbackConsumers = [
      'services/agents/NLUService.ts',
      'services/SentimentAnalysisService.ts',
      'services/agents/orchestration/SupportPlaybookPresentationService.ts',
      'services/knowledge/KnowledgeReranker.ts',
    ];
    for (const relativePath of supportFallbackConsumers) {
      const source = fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
      expect(source).toContain('LLMProviderFactory.createChatCompletionWithFallback');
      expect(source).not.toContain('provider.createChatCompletion({');
    }
  });
});
