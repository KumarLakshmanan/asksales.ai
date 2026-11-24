import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), '..', path), 'utf8');

describe('outreach delivery persistence', () => {
  it('lets the durable outbox own the only text-message ledger write', () => {
    const stage = read('server/services/agents/pipeline/stages/DeliveryStage.ts');
    expect(stage).toContain('await deliveryOutboxService.completeClaimedAction(');
    expect(stage).not.toContain('ON CONFLICT (delivery_action_id) DO NOTHING');
    expect(stage).not.toContain('recipientPhone: senderIdentifier');
  });

  it('matches the partial delivery-action index for voice replies', () => {
    const service = read('server/services/OutreachVoiceReplyDeliveryService.ts');
    expect(service).toContain(
      'ON CONFLICT (delivery_action_id) WHERE delivery_action_id IS NOT NULL DO NOTHING',
    );
  });

  it('does not put TypeScript comments inside the hotel availability query', () => {
    const agent = read('server/mastra/agents/supportAgent.ts');
    const queryStart = agent.indexOf('SELECT ra.room_type_id');
    const queryEnd = agent.indexOf('`).then(', queryStart);
    expect(agent.slice(queryStart, queryEnd)).not.toContain('//');
  });

  it('grounds greetings and side-effect claims in the current turn and date', () => {
    const agent = read('server/mastra/agents/supportAgent.ts');
    const hotelAgent = read('server/services/agents/HotelSalesAgent.ts');
    expect(agent).toContain('Current Date (UTC): ${currentDateUtc}');
    expect(agent).toContain('unless an authorized tool returned a successful result in this current turn');
    expect(agent).toContain('If the latest customer message is only a greeting or acknowledgement');
    expect(agent).toContain('Do not resurrect an old request');
    expect(hotelAgent).toContain('LATEST-TURN PRIORITY');
    expect(hotelAgent).toContain('Do not resurrect an old request');
    expect(hotelAgent).toContain('Treat dates before ${today} as historical');
    expect(hotelAgent).toContain('SIDE-EFFECT TRUTHFULNESS');
  });
});
