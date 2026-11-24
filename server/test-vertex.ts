import dotenv from 'dotenv';
dotenv.config({ path: '.env.development' });
import { ImageGenerationWorker } from './tools/imageGenerationWorker.js';

async function run() {
  console.log("Initializing ImageGenerationWorker...");
  const worker = new ImageGenerationWorker(1);
  try {
    console.log("Calling generateFromText...");
    const result = await worker.generateFromText("A cute golden retriever puppy playing in a futuristic cyber city");
    console.log("Image generation result:", result);
  } catch(e) {
    console.error("Image generation FAILED:", e);
  }
}
run();
