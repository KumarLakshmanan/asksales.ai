#!/usr/bin/env node
/**
 * Test script for image generation
 * Tests the full image generation pipeline including:
 * - DB credentials lookup (gemini_image admin credential)
 * - Vertex AI service account detection
 * - Image generation via GoogleGenAI SDK
 * - File saving to uploads/
 *
 * Usage:
 *   cd server && node scripts/test-image-generation.mjs
 *   cd server && node scripts/test-image-generation.mjs "a futuristic office space with AI robots"
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load server .env
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const prompt = process.argv[2] || 'A professional marketing banner for a SaaS product with modern design, blue tones, white background';

console.log('\n========================================');
console.log('  Image Generation Test Script');
console.log('========================================\n');
console.log(`Prompt: "${prompt}"\n`);

// ── Step 1: Check DB connection ─────────────────────────────────────────────
console.log('Step 1: Checking database connection...');
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_DATABASE || process.env.DB_NAME || 'salesmarketing',
});

let client;
try {
  client = await pool.connect();
  const res = await client.query('SELECT version()');
  console.log('  ✅ DB connected:', res.rows[0].version.split(' ').slice(0,2).join(' '), '\n');
} catch (err) {
  console.error('  ❌ DB connection failed:', err.message);
  process.exit(1);
}

// ── Step 2: Check admin credentials for Gemini Image ────────────────────────
console.log('Step 2: Checking Gemini Image admin credentials...');
let geminiCred = null;
try {
  const credRes = await client.query(
    `SELECT id, api_key, api_secret, config, is_active 
     FROM admin_api_credentials 
     WHERE platform IN ('gemini_image', 'gemini') AND is_active = true
     ORDER BY CASE WHEN platform = 'gemini_image' THEN 0 ELSE 1 END, created_at DESC
     LIMIT 1`
  );
  if (credRes.rows.length === 0) {
    console.error('  ❌ No active Gemini Image credential found in admin_api_credentials table.');
    console.error('     Please configure one at Admin > Integrations > Gemini Image.');
    process.exit(1);
  }
  geminiCred = credRes.rows[0];
  console.log(`  ✅ Found credential: provider matching ID=${geminiCred.id}, active=${geminiCred.is_active}`);
  console.log(`     api_key: ${geminiCred.api_key ? geminiCred.api_key.substring(0, 8) + '...' : 'MISSING'}`);
  console.log(`     api_secret (Project ID): ${geminiCred.api_secret ? geminiCred.api_secret.substring(0, 20) + '...' : 'NOT SET'}`);
  console.log(`     config: ${JSON.stringify(geminiCred.config || {})}`);
  console.log();
} catch (err) {
  console.error('  ❌ Failed to query admin credentials:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}

// ── Step 3: Check Vertex AI service account ──────────────────────────────────
console.log('Step 3: Checking Vertex AI service account...');
const serviceAccountDirs = [
  path.resolve(__dirname, '..', 'data', 'service-accounts'),
  path.resolve(__dirname, '..', 'config'),
];
let serviceAccountPath = null;
let serviceAccountData = null;

for (const dir of serviceAccountDirs) {
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (content.type === 'service_account' && content.project_id) {
        serviceAccountPath = filePath;
        serviceAccountData = content;
        break;
      }
    } catch {}
  }
  if (serviceAccountData) break;
}

if (serviceAccountData) {
  console.log(`  ✅ Service account found: ${serviceAccountPath}`);
  console.log(`     Project: ${serviceAccountData.project_id}`);
  console.log(`     Client email: ${serviceAccountData.client_email}`);
  console.log();
} else {
  console.log('  ⚠️  No service account JSON found. Will use Vertex Project ID from credentials.');
  if (!geminiCred.api_secret) {
    console.error('  ❌ FATAL: No service account AND no Project ID (api_secret) configured!');
    console.error('     Either place a service account JSON in server/data/service-accounts/');
    console.error('     OR set the Vertex AI Project ID in Admin > Integrations > Gemini Image > API Secret.');
    process.exit(1);
  }
  console.log(`     Using Project ID: ${geminiCred.api_secret}\n`);
}

// ── Step 4: Initialize GoogleGenAI ──────────────────────────────────────────
console.log('Step 4: Initializing GoogleGenAI client...');
let ai;
try {
  const { GoogleGenAI } = await import('@google/genai');
  const config = geminiCred.config || {};
  const location = config.location || 'us-central1';
  // Valid image generation models — reject plain LLM model names
  const VALID_IMAGE_MODELS = [
    'gemini-2.5-flash-image',
    'gemini-2.0-flash-preview-image-generation',
    'gemini-2.0-flash-exp',
    'gemini-2.0-flash-exp-image-generation',
    'imagen-3.0-generate-002',
    'imagen-3.0-fast-generate-001',
  ];
  const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image';
  const configuredModel = config.model;
  const modelName = (configuredModel && VALID_IMAGE_MODELS.includes(configuredModel))
    ? configuredModel
    : DEFAULT_IMAGE_MODEL;
  if (configuredModel && !VALID_IMAGE_MODELS.includes(configuredModel)) {
    console.log(`  ⚠️  Admin credential has invalid model "${configuredModel}" — using default: ${modelName}`);
  }

  if (serviceAccountData) {
    ai = new GoogleGenAI({
      vertexai: true,
      project: serviceAccountData.project_id,
      location,
      googleAuthOptions: {
        credentials: serviceAccountData,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      },
    });
    console.log(`  ✅ Using Vertex AI with service account (project: ${serviceAccountData.project_id}, location: ${location})`);
  } else if (geminiCred.api_key) {
    ai = new GoogleGenAI({ apiKey: geminiCred.api_key });
    console.log(`  ✅ Using API key (no service account)`);
  } else {
    console.error('  ❌ No service account and no API key found!');
    process.exit(1);
  }
  console.log(`     Model: ${modelName}\n`);

  // ── Step 5: Generate image ─────────────────────────────────────────────────
  console.log('Step 5: Generating image...');
  console.log('  (This may take 15-30 seconds...)\n');

  const startTime = Date.now();
  const response = await ai.models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  ✅ API call completed in ${elapsed}s`);

  // ── Step 6: Extract and save image ────────────────────────────────────────
  console.log('\nStep 6: Extracting image from response...');
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.data);

  if (!imagePart?.inlineData?.data) {
    console.error('  ❌ No image data in response!');
    console.log('  Response structure:', JSON.stringify({
      candidatesCount: response?.candidates?.length || 0,
      partsCount: parts.length,
      partTypes: parts.map(p => Object.keys(p)),
    }, null, 2));
    process.exit(1);
  }

  const base64Data = imagePart.inlineData.data;
  const mimeType = imagePart.inlineData.mimeType || 'image/png';
  const ext = mimeType.split('/')[1] || 'png';
  
  console.log(`  ✅ Image received: ${mimeType}, base64 length: ${base64Data.length} chars`);

  // Save to uploads directory
  const uploadsDir = path.resolve(__dirname, '..', 'uploads', 'test-images');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  
  const fileName = `test-image-${Date.now()}.${ext}`;
  const filePath = path.join(uploadsDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
  
  console.log(`  ✅ Image saved to: ${filePath}`);
  console.log(`     File size: ${(fs.statSync(filePath).size / 1024).toFixed(1)} KB`);

  // ── Step 7: Summary ───────────────────────────────────────────────────────
  console.log('\n========================================');
  console.log('  ✅ IMAGE GENERATION TEST PASSED!');
  console.log('========================================');
  console.log(`  Prompt: "${prompt}"`);
  console.log(`  File:   ${filePath}`);
  console.log(`  Time:   ${elapsed}s`);
  console.log();

} catch (err) {
  console.error('\n  ❌ Image generation FAILED!');
  console.error('  Error:', err.message);
  if (err.message?.includes('service account')) {
    console.error('\n  FIX: Place a valid Google Cloud service account JSON in server/data/service-accounts/');
    console.error('       OR configure the Vertex AI Project ID in Admin > Integrations > Gemini Image.');
  } else if (err.message?.includes('quota') || err.message?.includes('429')) {
    console.error('\n  FIX: Quota exceeded. Wait a few minutes or configure a different Gemini Image credential.');
  } else if (err.message?.includes('PERMISSION_DENIED') || err.message?.includes('permission')) {
    console.error('\n  FIX: The service account does not have Vertex AI permissions. Enable these APIs:');
    console.error('       - Vertex AI API (aiplatform.googleapis.com)');
    console.error('       - Grant the service account the "Vertex AI User" role (roles/aiplatform.user)');
  } else if (err.message?.includes('not configured') || err.message?.includes('API key')) {
    console.error('\n  FIX: No Gemini Image credentials configured.');
    console.error('       Go to Admin > Integrations > Gemini Image and add your credentials.');
  }
  if (process.env.DEBUG) {
    console.error('\n  Full error:', err);
  }
  process.exit(1);
}
