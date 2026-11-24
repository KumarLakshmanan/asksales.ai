---
applyTo: 'server/**'
---

# Email Outreach Instructions for GitHub Copilot

## Email Provider Binding

Outreach uses the selected verified Resend or Gmail OAuth account through
`ProviderBindingService` and `emailService.sendEmailWithUserCredentials`.
Retain the reviewed account identifier and credential binding through queueing;
revalidate the binding before sending. Do not add raw SMTP/environment-password
or browser-automation fallbacks to this delivery path.

## Email Sending Service Pattern
```typescript
import { emailService } from '../services/emailService.js';

await emailService.sendEmailWithUserCredentials(ownerUserId, {
  to: 'recipient@example.com',
  subject: 'Subject',
  html: '<p>Content</p>',
  inReplyTo: parentRfcMessageId,  // For threading (RFC5322)
  references: referencesChain,  // Full chain
  threadId: 'gmail-thread-id'  // For Gmail API
}, reviewedSenderId);
```

## Email Threading (CRITICAL)
All reply emails MUST include:
- **inReplyTo**: RFC5322 Message-ID of parent message (for `In-Reply-To` header)
- **references**: Full chain of Message-IDs (for `References` header)
- **threadId** (Gmail only): Gmail API thread ID (for `requestBody.threadId`)

**Pattern**:
```typescript
// When sending a reply:
await emailService.sendEmailWithUserCredentials(ownerUserId, {
  to: 'original-sender@example.com',
  subject: 'Re: Original Subject',
  html: '<p>Reply content</p>',
  inReplyTo: '<original-message-id>',
  references: '<original-message-id> <previous-message-ids>',
  threadId: threadIdFromGmailApi
});

// When receiving a reply (via inbound handler):
const messageId = parseMessageId(incomingEmail);  // Extract from email headers
const inReplyTo = incomingEmail.headers['in-reply-to'];
const references = incomingEmail.headers['references'];
// Store these to reconstruct thread chain
```

## Inbound Email Processing
**Pipeline**:
1. **Duplicate Guard** → Check `sent_messages` for existing `message_id`
2. **Thread Matching** → Find original outbound via `In-Reply-To` Message-ID match
3. **User Resolution** → Resolve owner via: user email → `email_senders` → `resend_domains` → `channel_credentials`
4. **Lead Resolution** → Find or create lead for sender
5. **Conversation Upsert** → Get or create `outreach_conversations` record
6. **Auto-Reply Pipeline** → Run sentiment analysis, smart reply generation, auto-actions

## Personalization Tokens
```
{{first_name}} {{last_name}} {{full_name}} {{email}}
{{company_name}} {{job_title}} {{company_industry}}
{{company}} {{role}} {{industry}} {{headline}} {{location}}
```

## Campaign and Follow-up Delivery

The central Inbox composer reviews recipients, sender, copy and timing before
queueing. A queue acknowledgement establishes enqueue acceptance; a provider
receipt establishes provider acceptance. Actual delivery requires separate
provider evidence. Unconfirmed outcomes need reconciliation, not blind resend.

Configured follow-ups carry the single version-1 `followUpProvenance` contract.
Validate current settings, template/render context and original conversation
state after preparation, preserve claim tokens, and stop invalidated work before
the provider boundary. Keep exact RFC threading identity separate from provider
API IDs. Apply address suppression and configured outreach quotas independently
of subscription and wallet checks.

## Email Sentiment Analysis
**Sentiment Score Ranges**:
- **> 0.8**: Very positive
- **0.5 to 0.8**: Positive
- **-0.5 to 0.5**: Neutral
- **-0.8 to -0.5**: Negative
- **< -0.8**: Very negative

**Auto-Ticket Creation** (if enabled):
- Score < -0.8 → Ticket created with `urgent` priority, tags: `['auto-created', 'negative-sentiment']`
- Score -0.5 to -0.8 → Ticket created with `high` priority
- Score ≥ -0.5 → No auto ticket

## Email Sending Services Integration
- **Resend and Gmail OAuth**: resolve the reviewed account through the official provider binding service.
- **Recipient eligibility**: use the creation preflight and final suppression checks; do not infer eligibility from an old preview.
- **Retry and recovery**: distinguish unstarted preparation, explicit rejection and uncertain provider starts. Preserve durable send identity and receipts.
- **Bounce handling**: reconcile delivery evidence and suppress affected destinations within the selected business.

## Email Template System
Templates stored in database with variables for personalization. Template format:
```
Subject: {{subject_template}}
---
{{opening}}

Body content with {{personalization_tokens}}

{{closing}}
```

## Live Email Tracking
- **Open Tracking**: Pixel-based tracking in email content
- **Click Tracking**: URL rewriting for click tracking
- **Reply Tracking**: Automatic detection via inbound email handler
- **Bounce/Complaint**: Webhook callbacks from email providers

## Email Campaign Structure
```typescript
{
  id: string;
  userId: number;
  name: string;
  channel: 'email';
  status: 'draft' | 'scheduled' | 'sending' | 'completed' | 'paused';
  schedule: {
    startTime: Date;
    endTime?: Date;
    frequency?: 'daily' | 'weekly' | 'monthly';
    daysOfWeek?: number[];
    hoursOfDay?: number[];
  };
  targets: {
    leadIds: number[];
    tags: string[];
    filters: FilterCondition[];
  };
  content: {
    subject: string;
    body: string;
    template?: string;
    variables: Record<string, string>;
  };
  senderId?: number;  // Specific sender to use
  tracking: {
    openTracking: boolean;
    clickTracking: boolean;
    replyTracking: boolean;
  };
  results: {
    sent: number;
    opened: number;
    clicked: number;
    replied: number;
    bounced: number;
    complained: number;
  };
}
```

## Smart Reply Generation
When a reply is detected:
1. Extract sentiment and key topics from reply
2. Generate contextual response using LLM
3. Show as suggestion to user (requires approval)
4. Auto-send if user enables auto-replies

## Integration Points
- **Gmail**: `gmailApiService` (OAuth2, token refresh)
- **Outlook**: `emailService` (via Microsoft Graph API if configured)
- **Resend**: Direct API calls for sending
- **Webhook Handlers**: `/api/webhooks/email` for bounces, complaints
- **Inbound Processing**: `/api/webhooks/inbound-email` for receiving replies

## Critical Rules
- **ALWAYS include `inReplyTo` and `references`** for all reply emails
- **Validate the reviewed recipient and final suppression state** before dispatch.
- **ALWAYS use senderId** if user has multiple email senders configured
- **Preserve the reviewed official provider binding** throughout preparation and dispatch.
- **Preserve provider receipt IDs and exact RFC message IDs** in their distinct persistence fields.
