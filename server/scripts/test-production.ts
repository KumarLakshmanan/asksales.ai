import dotenv from 'dotenv';
dotenv.config({ path: '.env.development' }); // Although on production it will be using production env from docker, but just in case
import { ImageGenerationWorker } from '../tools/imageGenerationWorker.js';
import { VideoGenerationWorker } from '../tools/videoGenerationWorker.js';

async function runTest() {
  console.log("=== Testing Image Generation on Production ===");
  try {
    // Pass user ID 1 or thread ID 9999 to use the correct admin credentials
    const imageWorker = new ImageGenerationWorker(1, 9999);
    const imageResult = await imageWorker.generateFromText("A futuristic city skyline at sunset, cyberpunk style, high resolution");
    console.log("Image generation SUCCESS!");
    console.log(JSON.stringify(imageResult, null, 2));
  } catch (e) {
    console.error("Image generation FAILED:", e);
  }

  console.log("\n=== Testing Video Generation on Production ===");
  try {
    const videoWorker = new VideoGenerationWorker(1, 9999);
    const videoResult = await videoWorker.generateFromText("A futuristic city skyline at sunset, with flying cars zooming past, cyberpunk style, cinematic lighting");
    console.log("Video generation SUCCESS!");
    console.log(JSON.stringify(videoResult, null, 2));
  } catch (e) {
    console.error("Video generation FAILED:", e);
  }

  process.exit(0);
}

runTest();
