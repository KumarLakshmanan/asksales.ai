import { subAgentRegistry } from './SubAgentRegistry.js';
import { bookingSubAgent } from './BookingSubAgent.js';
import { negotiationSubAgent } from './NegotiationSubAgent.js';
import { complaintSubAgent } from './ComplaintSubAgent.js';
import { ticketSubAgent } from './TicketSubAgent.js';
import { paymentSubAgent } from './PaymentSubAgent.js';
import { escalationSubAgent } from './EscalationSubAgent.js';
import { knowledgeBaseSubAgent } from './KnowledgeBaseSubAgent.js';
import { qualificationSubAgent } from './QualificationSubAgent.js';
import { proposalSubAgent } from './ProposalSubAgent.js';
import { chatHistorySubAgent } from './ChatHistorySubAgent.js';

// Register all Outreach / Sales sub-agents
subAgentRegistry.register(bookingSubAgent);
subAgentRegistry.register(negotiationSubAgent);
subAgentRegistry.register(complaintSubAgent);
subAgentRegistry.register(ticketSubAgent);
subAgentRegistry.register(paymentSubAgent);
subAgentRegistry.register(escalationSubAgent);
subAgentRegistry.register(knowledgeBaseSubAgent);
subAgentRegistry.register(qualificationSubAgent);
subAgentRegistry.register(proposalSubAgent);
subAgentRegistry.register(chatHistorySubAgent);

export * from './SubAgentBase.js';
export * from './SubAgentRegistry.js';
export * from './BookingSubAgent.js';
export * from './NegotiationSubAgent.js';
export * from './ComplaintSubAgent.js';
export * from './TicketSubAgent.js';
export * from './PaymentSubAgent.js';
export * from './EscalationSubAgent.js';
export * from './KnowledgeBaseSubAgent.js';
export * from './QualificationSubAgent.js';
export * from './ProposalSubAgent.js';
