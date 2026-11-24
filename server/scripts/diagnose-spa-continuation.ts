/** No-send NLU replay: synthetic non-personal turns only. No gateway, journey
 * writes, callbacks or customer delivery. Provider usage is logged normally. */
import { nluService } from '../services/agents/NLUService.js';

const ownerId = Number(process.argv[2]);
if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error('A valid owner ID is required.');
const scenarios = [
  { text: '23 September 2026 at 4 PM.', service: 'spa', answer: true },
  { text: 'Tomorrow afternoon around four would suit me.', service: 'spa', answer: true },
  { text: 'September 25, 2026 at 7 PM.', service: 'dining', answer: true },
  { text: "I'd like to book a Spa Slot", service: 'spa', answer: false },
  { text: "I haven't chosen a date yet.", service: 'spa', answer: false },
];
try {
  for (const { text, service, answer } of scenarios) {
    const recent = `Customer: I'd like to make a ${service} reservation\nAgent: What date and time would work best for you?`;
    const result = await nluService.analyze(ownerId, text, recent);
    const dateTime = result.entities['service.dateTime'];
    const passed = answer
      ? result.semanticRequest?.action === 'continue' && result.semanticRequest?.topicSwitch === false
        && result.semanticRequest.service === service && typeof dateTime === 'string' && dateTime.trim().length > 0
      : dateTime == null;
    console.log('SPA_NLU_REPLAY=' + JSON.stringify({ text, intent: result.intent,
      semanticRequest: result.semanticRequest, entities: result.entities,
      classificationConfidence: result.classificationConfidence, passed }));
    if (!passed) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'NLU replay failed.');
  process.exitCode = 1;
} finally { process.exit(process.exitCode || 0); }
