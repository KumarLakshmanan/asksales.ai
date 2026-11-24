import type { PlaybookGraph } from '../../models/supportOrchestration/schema.js';

export const ORO_UNCERTAINTY_GUIDANCE = `Answer the customer's actual question using confirmed, customer-authorized knowledge. Internal sales targets, ARR, negotiation ceilings and staff scripts are not guest-facing facts. If evidence is missing, conflicting or unconfirmed, say: "I’m not sure about that from the information I have. Would you like me to connect you with a human support agent?" An offer is not a completed handoff. Wait for affirmative acceptance, then use the actual human-support workflow and report only its confirmed result. Never guess a rate, cancellation rule, service time or promised response deadline. The breakfast-hours entry saying 8 AM–10 PM is unconfirmed; do not quote or silently correct it. Ordinary restaurant walk-ins and advance group buffet bookings are different cases; do not promise buffet service for an ordinary walk-in. Use live tools for room rates/availability, and retain all qualifications on published packages. A new service request must not be answered with stale room/event questions. Respect explicit corrections and do not reuse old booking or callback consent.`;

const safeDemoReplies:Record<string,string>={
  ss4x9req:'Namaskara! I’m Oro’s AI assistant. Could you share your name and company, and the dates you have in mind? Availability still needs to be checked.',
  '53i0diqe':'I can help prepare a proposal based on your requirements. Pricing and delivery time need confirmation; I cannot promise a proposal by a particular time yet.',
  '6mqi39qr':'Namaskara! I’m Oro’s AI assistant. Could you share your name and agency so I can understand your enquiry?',
  b508atcj:'Thank you. The team needs to confirm availability and any inclusions before a visit or callback is scheduled.',
  jx7771m0:'Namaskara, and congratulations! Could you share your name and preferred event date? The suitable venue and capacity need to be verified for your requirements.',
  s625nmm7:'Would you like me to connect you with our human support team to discuss a site visit? I have not scheduled a visit or sent any material yet.',
};

export function repairOroGuidance(graph:PlaybookGraph, training:unknown[]) {
  const updated=structuredClone(graph);
  for(const node of updated.nodes) {
    if(node.type==='capability' && node.data?.capabilityName==='knowledge.answer') {
      node.data.instruction=[node.data.instruction,ORO_UNCERTAINTY_GUIDANCE].filter(Boolean).join('\n\n');
    }
  }
  const demos=structuredClone(training) as Array<{id?:string;messages?:Array<{id?:string;role:string;content:string}>}>;
  for(const demo of demos)for(const message of demo.messages||[]) {
    if(message.role!=='user' && message.id && safeDemoReplies[message.id])message.content=safeDemoReplies[message.id];
  }
  return {graph:updated,training:demos};
}
