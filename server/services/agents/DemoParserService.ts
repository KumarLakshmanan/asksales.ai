import { prepareDemoInput, DEMO_MAX_TEXT } from '../../utils/boundedDemoInput.js';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import { getActiveAdminCredential } from '../../models/adminApiCredentials/functions.js';
import { logger } from '../../utils/logger.js';

export interface ExtractedMessage {
  role: 'user' | 'agent';
  content: string;
}

export class DemoParserService {
  /**
   * Parse a file (screenshot or PDF) to extract conversation turns.
   */
  static async parseFile(
    fileBuffer: Buffer,
    mimetype: string,
    filename: string
  ): Promise<ExtractedMessage[]> {
    logger.info({ filename, mimetype }, '[DemoParserService] Parsing training demo file');

    const prepared = await prepareDemoInput(fileBuffer, mimetype);
    const isImage = Boolean(prepared.image);
    const textContent = prepared.text;
    fileBuffer = prepared.image || fileBuffer;
    if (isImage) mimetype = 'image/jpeg';
    const [openaiCred, geminiCred, openrouterCred] = await Promise.all([
      getActiveAdminCredential('openai'), getActiveAdminCredential('gemini'), getActiveAdminCredential('openrouter'),
    ]);

    const prompt = `You are an AI assistant designed to extract conversational training dialogues between a Customer/User and an AI Agent/Staff from the provided image/document.

Identify all messages exchanged in chronological order. For each message, extract:
1. The role: "user" (customer/guest) or "agent" (staff/assistant/AI).
2. The exact message content.

Output ONLY a JSON array of objects with the exact schema:
[
  { "role": "user" | "agent", "content": "message text" },
  ...
]

Do not include any wrapper (like \`\`\`json ... \`\`\`), markdown, prefaces, or explanation. Output a raw JSON array.`;

    let responseText = '';

    // 2. Dispatch based on available credentials and file type
    if (openaiCred?.apiKey) {
      logger.info('[DemoParserService] Using OpenAI to parse file');
      const openai = new OpenAI({ apiKey: openaiCred.apiKey, timeout: 20_000, maxRetries: 0 });
      const model = openaiCred.config?.model || 'gpt-4o';

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const content: any = isImage
        ? [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimetype};base64,${fileBuffer.toString('base64')}`,
              },
            },
          ]
        : prompt + '\n\nHere is the extracted document text:\n' + textContent;

      const completion = await openai.chat.completions.create({
        model,
        messages: [{ role: 'user', content }],
        response_format: { type: 'json_object' },
        max_completion_tokens: 2048,
        temperature: 0.1,
      });

      responseText = completion.choices[0]?.message?.content || '';
    } else if (geminiCred?.apiKey) {
      logger.info('[DemoParserService] Using Gemini to parse file');
      const model = geminiCred.config?.model || 'gemini-1.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiCred.apiKey}`;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts: any[] = [];
      if (isImage) {
        parts.push({ text: prompt });
        parts.push({
          inlineData: {
            mimeType: mimetype,
            data: fileBuffer.toString('base64'),
          },
        });
      } else {
        parts.push({ text: prompt + '\n\nHere is the extracted document text:\n' + textContent });
      }

      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        size: 256 * 1024,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: 2048,
          },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API error: ${response.status} - ${errText}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resJson = (await response.json()) as any;
      responseText = resJson.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else if (openrouterCred?.apiKey) {
      logger.info('[DemoParserService] Using OpenRouter to parse file');
      const model =
        openrouterCred.config?.selectedModel ||
        openrouterCred.config?.model ||
        'google/gemini-2.5-flash';

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const content: any = isImage
        ? [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimetype};base64,${fileBuffer.toString('base64')}`,
              },
            },
          ]
        : prompt + '\n\nHere is the extracted document text:\n' + textContent;

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        size: 256 * 1024,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openrouterCred.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content }],
          response_format: { type: 'json_object' },
          max_tokens: 2048,
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} - ${errText}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resJson = (await response.json()) as any;
      responseText = resJson.choices?.[0]?.message?.content || '';
    } else {
      throw new Error('No active LLM credentials configured. Please configure OpenAI, Gemini, or OpenRouter.');
    }

    // 3. Clean and parse JSON response
    if (!responseText.trim()) {
      throw new Error('LLM returned an empty response');
    }

    // Strip markdown JSON block if present
    let jsonStr = responseText.trim();
    if (jsonStr.startsWith('```')) {
      const start = jsonStr.indexOf('[');
      const end = jsonStr.lastIndexOf(']');
      if (start !== -1 && end !== -1 && end >= start) {
        jsonStr = jsonStr.substring(start, end + 1);
      }
    }

    try {
      let parsed = JSON.parse(jsonStr);
      // If LLM wrapped it inside a key e.g. { "messages": [...] } or { "conversation": [...] }
      if (!Array.isArray(parsed)) {
        const possibleArray = Object.values(parsed).find((val) => Array.isArray(val));
        if (possibleArray) {
          parsed = possibleArray;
        } else {
          throw new Error('Extracted output is not an array');
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const formatted = parsed.map((m: any) => ({
        role: m.role === 'user' ? 'user' : 'agent',
        content: String(m.content || m.text || '').trim(),
      }));

      // Filter out empty messages
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return formatted.filter((m: any) => m.content.length > 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (parseError: any) {
      logger.error({ responseText, parseError }, '[DemoParserService] Failed to parse JSON response');
      throw new Error(`Failed to parse extracted dialogue: ${parseError.message}`);
    }
  }

  /**
   * Generate conversation training dialogue based on knowledge base text content.
   */
  static async parseText(text: string): Promise<ExtractedMessage[]> {
    if (typeof text !== 'string' || text.length > DEMO_MAX_TEXT) throw new Error('Demo text exceeds 40000 characters');
    logger.info('[DemoParserService] Parsing training demo from raw text');

    // 1. Resolve active LLM credentials
    const [openaiCred, geminiCred, openrouterCred] = await Promise.all([
      getActiveAdminCredential('openai'),
      getActiveAdminCredential('gemini'),
      getActiveAdminCredential('openrouter'),
    ]);

    const prompt = `You are an AI assistant designed to generate a typical realistic user-agent conversation flow based on the provided facts and information.
Generate a conversational training dialogue that covers the key details in the information.

Identify the sequence of messages in chronological order. Each message must have:
1. The role: "user" (customer/guest) or "agent" (staff/assistant/AI).
2. The exact message content.

Output ONLY a JSON array of objects with the exact schema:
[
  { "role": "user" | "agent", "content": "message text" },
  ...
]

Do not include any wrapper (like \`\`\`json ... \`\`\`), markdown, prefaces, or explanation. Output a raw JSON array.`;

    let responseText = '';

    // 2. Dispatch based on available credentials
    if (openaiCred?.apiKey) {
      const openai = new OpenAI({ apiKey: openaiCred.apiKey, timeout: 20_000, maxRetries: 0 });
      const model = openaiCred.config?.model || 'gpt-4o-mini';

      const completion = await openai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt + '\n\nHere is the information:\n' + text }],
        response_format: { type: 'json_object' },
        max_completion_tokens: 2048,
        temperature: 0.3,
      });

      responseText = completion.choices[0]?.message?.content || '';
    } else if (geminiCred?.apiKey) {
      const model = geminiCred.config?.model || 'gemini-1.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiCred.apiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        size: 256 * 1024,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt + '\n\nHere is the information:\n' + text }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: 2048,
          },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API error: ${response.status} - ${errText}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resJson = (await response.json()) as any;
      responseText = resJson.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else if (openrouterCred?.apiKey) {
      const model =
        openrouterCred.config?.selectedModel ||
        openrouterCred.config?.model ||
        'google/gemini-2.5-flash';

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        size: 256 * 1024,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openrouterCred.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt + '\n\nHere is the information:\n' + text }],
          response_format: { type: 'json_object' },
          max_tokens: 2048,
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} - ${errText}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resJson = (await response.json()) as any;
      responseText = resJson.choices?.[0]?.message?.content || '';
    } else {
      throw new Error('No active LLM credentials configured. Please configure OpenAI, Gemini, or OpenRouter.');
    }

    // 3. Clean and parse JSON response
    if (!responseText.trim()) {
      throw new Error('LLM returned an empty response');
    }

    let jsonStr = responseText.trim();
    if (jsonStr.startsWith('```')) {
      const start = jsonStr.indexOf('[');
      const end = jsonStr.lastIndexOf(']');
      if (start !== -1 && end !== -1 && end >= start) {
        jsonStr = jsonStr.substring(start, end + 1);
      }
    }

    try {
      let parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) {
        const possibleArray = Object.values(parsed).find((val) => Array.isArray(val));
        if (possibleArray) {
          parsed = possibleArray;
        } else {
          throw new Error('Extracted output is not an array');
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const formatted = parsed.map((m: any) => ({
        role: m.role === 'user' ? 'user' : 'agent',
        content: String(m.content || m.text || '').trim(),
      }));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return formatted.filter((m: any) => m.content.length > 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (parseError: any) {
      logger.error({ responseText, parseError }, '[DemoParserService] Failed to parse JSON response');
      throw new Error(`Failed to parse extracted dialogue: ${parseError.message}`);
    }
  }

  /**
   * Generate multiple distinct conversation training dialogues based on knowledge base text content.
   */
  static async parseTextMulti(text: string): Promise<ExtractedMessage[][]> {
    if (typeof text !== 'string' || text.length > DEMO_MAX_TEXT) throw new Error('Demo text exceeds 40000 characters');
    logger.info('[DemoParserService] Parsing multiple training demos from raw text');

    // 1. Resolve active LLM credentials
    const [openaiCred, geminiCred, openrouterCred] = await Promise.all([
      getActiveAdminCredential('openai'),
      getActiveAdminCredential('gemini'),
      getActiveAdminCredential('openrouter'),
    ]);

    const prompt = `You are an AI assistant designed to generate multiple distinct, realistic user-agent conversation flows based on the provided facts and information.
Analyze the provided information and generate between 2 to 4 different conversation scenarios. Each scenario should cover a different topic, question, or aspect of the information.

For each conversation, identify the sequence of messages in chronological order. Each message must have:
1. The role: "user" (customer/guest) or "agent" (staff/assistant/AI).
2. The exact message content.

Output ONLY a JSON object with a "conversations" key containing an array of message arrays:
{
  "conversations": [
    [
      { "role": "user" | "agent", "content": "message text" },
      ...
    ],
    ...
  ]
}

Do not include any wrapper (like \`\`\`json ... \`\`\`), markdown, prefaces, or explanation. Output a raw JSON object.`;

    let responseText = '';

    // 2. Dispatch based on available credentials
    if (openaiCred?.apiKey) {
      const openai = new OpenAI({ apiKey: openaiCred.apiKey, timeout: 20_000, maxRetries: 0 });
      const model = openaiCred.config?.model || 'gpt-4o-mini';

      const completion = await openai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt + '\n\nHere is the information:\n' + text }],
        response_format: { type: 'json_object' },
        max_completion_tokens: 2048,
        temperature: 0.5,
      });

      responseText = completion.choices[0]?.message?.content || '';
    } else if (geminiCred?.apiKey) {
      const model = geminiCred.config?.model || 'gemini-1.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiCred.apiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        size: 256 * 1024,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt + '\n\nHere is the information:\n' + text }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: 2048,
          },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API error: ${response.status} - ${errText}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resJson = (await response.json()) as any;
      responseText = resJson.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else if (openrouterCred?.apiKey) {
      const model =
        openrouterCred.config?.selectedModel ||
        openrouterCred.config?.model ||
        'google/gemini-2.5-flash';

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        size: 256 * 1024,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openrouterCred.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt + '\n\nHere is the information:\n' + text }],
          response_format: { type: 'json_object' },
          max_tokens: 2048,
          temperature: 0.5,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} - ${errText}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resJson = (await response.json()) as any;
      responseText = resJson.choices?.[0]?.message?.content || '';
    } else {
      throw new Error('No active LLM credentials configured. Please configure OpenAI, Gemini, or OpenRouter.');
    }

    // 3. Clean and parse JSON response
    if (!responseText.trim()) {
      throw new Error('LLM returned an empty response');
    }

    let jsonStr = responseText.trim();
    if (jsonStr.startsWith('```')) {
      const start = jsonStr.indexOf('{');
      const end = jsonStr.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end >= start) {
        jsonStr = jsonStr.substring(start, end + 1);
      }
    }

    try {
      const parsed = JSON.parse(jsonStr);
      let conversationsArray = parsed.conversations;
      if (!Array.isArray(conversationsArray)) {
        const possibleArray = Object.values(parsed).find((val) => Array.isArray(val) && val.length > 0 && Array.isArray(val[0]));
        if (possibleArray) {
          conversationsArray = possibleArray;
        } else if (Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0])) {
          conversationsArray = parsed;
        } else if (Array.isArray(parsed)) {
          conversationsArray = [parsed];
        } else {
          throw new Error('Extracted output does not contain an array of conversations');
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const formattedConversations = conversationsArray.map((conv: any) => {
        if (!Array.isArray(conv)) return [];
        return conv
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((m: any) => ({
            role: m.role === 'user' ? 'user' : 'agent',
            content: String(m.content || m.text || '').trim(),
          }))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((m: any) => m.content.length > 0);
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return formattedConversations.filter((c: any) => c.length > 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (parseError: any) {
      logger.error({ responseText, parseError }, '[DemoParserService] Failed to parse JSON response');
      throw new Error(`Failed to parse extracted dialogue: ${parseError.message}`);
    }
  }
}
