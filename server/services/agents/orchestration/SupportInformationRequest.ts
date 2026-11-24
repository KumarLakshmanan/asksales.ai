import { confidentSemanticIntent, type SupportSemanticIntent } from './SupportSemanticIntent.js';

export function isBrochureInformationRequest(request?: SupportSemanticIntent): boolean {
  const intent = confidentSemanticIntent(request);
  return intent?.explicit === true && intent.action === 'document';
}

export function unavailableBrochureReply(pricingRequested: boolean, temporarilyUnavailable = false): string {
  return (temporarilyUnavailable
    ? 'I couldn’t check the available documents just now.'
    : 'We don’t have an approved document matching that request to share right now.')
    + (pricingRequested
      ? ' I also can’t confirm the requested price from the approved information retrieved.' : '')
    + ' Would you like me to connect you with our support team?';
}
