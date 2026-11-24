import { confidentSemanticIntent, type SupportSemanticIntent } from './SupportSemanticIntent.js';

/** Keeps negotiation capabilities bound to the latest customer turn. Historic
 * lead-memory concerns must not trigger a high-risk price proposal while the
 * customer is simply selecting a room or asking for a confirmation summary. */
export function hotelNegotiationToolPolicy(request?: SupportSemanticIntent): {
  allowNegotiation: boolean;
  allowObjectionHandling: boolean;
} {
  const semantic = confidentSemanticIntent(request);
  const latestNegotiation = semantic?.explicit === true && semantic.action === 'negotiation';
  return {
    allowNegotiation: latestNegotiation,
    allowObjectionHandling: latestNegotiation || (semantic?.explicit === true && semantic.action === 'objection'),
  };
}
