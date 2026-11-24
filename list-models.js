if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');
const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
ai.models.list().then(res => {
  for (const m of res) {
    if (m.name.includes('image')) console.log(m.name);
  }
}).catch(console.error);
