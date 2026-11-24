---
applyTo: 'server/**'
---

# Support Panel Instructions for GitHub Copilot

## Three Distinct Auth Systems (NEVER MIX THEM)

| Interface | URL Prefix | Auth System | Token Key | API Client | API Prefix | Auth Endpoint |
|-----------|-----------|-------------|-----------|------------|------------|---|
| **Support Portal** (agents) | `/support/*` | `SupportAuthContext` | `support_token` | `supportApi` | `/api/support-portal` | `/api/support-portal/me` |
| **Owner Dashboard** (business) | `/dashboard/support/*` | `AuthContext` | `token` | `api` | `/api/support` | `/api/auth/me` |
| **Embeddable Widget** (customers) | N/A (external) | `widget_token` | `widget_token` | REST calls | `/api/support-widget` | N/A |

**CRITICAL**: NEVER use `useAuth()` in support portal—always use `useSupportAuth()`.

## Support Portal Routes

### Public Routes
- `/support` → Redirector (auth → tickets, unauth → login)
- `/support/login` → Support member login

### Protected Routes (require `support_token`)
- `/support/dashboard` → Agent dashboard with stats
- `/support/tickets` → All assigned tickets list
- `/support/tickets/[id]` → Ticket detail with messages & AI chat sidebar
- `/support/chat` → Support AI chat (KB-powered)
- `/support/knowledge-base` → Read-only KB browser
- `/support/analytics` → Agent performance metrics
- `/support/profile` → Member profile view
- `/support/settings` → Password change

## Ticket Lifecycle

```
1. Created (via inbound email/form or auto-created from negative sentiment)
   ↓
2. Assigned to team/agent
   ↓
3. Agent views ticket, starts resolving
   ↓
4. Agent replies (internal notes or external customer message)
   ↓
5. Agent updates status (open, waiting, resolved, closed)
   ↓
6. Agent marks resolved/closed
   ↓
7. Review request sent to customer (if enabled)
   ↓
8. Customer submits review via token link or in-app
```

## Auto-Ticket Creation from Sentiment
When email reply has negative sentiment (score < -0.5):

```typescript
const sentiment = await analyzeSentiment(emailBody);
if (sentiment.score < -0.5) {
  const ticket = await SupportService.autoCreateTicketOnNegativeSentiment({
    leadEmail: sender.email,
    sentiment: sentiment.score,
    tags: ['auto-created', 'negative-sentiment'],
    priority: sentiment.score < -0.8 ? 'urgent' : 'high'
  });
}
```

## Support Database Models

### Tickets
```typescript
{
  id: number;
  teamId: number;
  assignedMemberId?: number;
  leadEmail: string;
  title: string;
  description: string;
  status: 'open' | 'waiting' | 'resolved' | 'closed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  closedAt?: Date;
  sentiment?: number;  // -1 to 1
  autoCreated?: boolean;
}
```

### Ticket Messages
```typescript
{
  id: number;
  ticketId: number;
  authorId?: number;  // NULL for customer
  type: 'internal' | 'external';  // internal = agent-only, external = visible to customer
  content: string;
  sentiment?: number;
  createdAt: Date;
}
```

### Support Teams
```typescript
{
  id: number;
  userId: number;  // Team owner
  name: string;
  description?: string;
  members: SupportMember[];  // Team members
  settings: {
    autoReplyEnabled: boolean;
    sentimentThreshold: number;  // Default -0.5
    reviewsEnabled: boolean;
    knowledgeBaseAccessible: boolean;
  };
}
```

### Support Members
```typescript
{
  id: number;
  teamId: number;
  memberEmail: string;
  name: string;
  role: 'admin' | 'agent' | 'viewer';
  status: 'active' | 'inactive';
  joinedAt: Date;
}
```

## Support Auth Pattern

### Support Portal Auth (Use in `/support/*` routes only)
```typescript
import { useSupportAuth } from "@/contexts/SupportAuthContext";
const { member, isLoading, logout } = useSupportAuth();

// For protected pages:
import { SupportProtectedRoute } from "@/components/support/SupportProtectedRoute";
<SupportProtectedRoute><YourPage /></SupportProtectedRoute>
```

### Support API Calls
```typescript
import { supportApi } from "@/lib/support-api";
const tickets = await supportApi.get("/api/support-portal/tickets");
const result = await supportApi.post("/api/support-portal/tickets/123/messages", { content, type: 'external' });
```

### Owner Dashboard Auth (Use in `/dashboard/support/*` routes)
```typescript
import { useAuth } from "@/contexts/AuthContext";
const { user } = useAuth();
// Regular API client (not supportApi)
```

## Knowledge Base in Support
- Read-only access for support agents
- AI-powered search with embedding vectors
- Auto-suggested articles when viewing tickets
- FAQ support for self-service
- Integrated with main platform's knowledge base

## Support AI Chat
- Available to agents for generating/suggesting replies
- Context-aware (ticket info, linked lead, conversation history)
- Sentiment-aware (suggests tone based on customer emotion)
- Smart reply suggestions shown alongside ticket
- Full KB access for answer generation

## Sentiment Analysis for Support
**When triggered**:
- Inbound customer email received
- Ticket auto-created if score < -0.5
- Suggestions shown to agent (sympathy, urgency)
- Auto-actions triggered if enabled (escalate, assign priority, etc.)

## Integration Points
- **Support Portal**: Separate auth, KB access, ticket management
- **Owner Dashboard**: Team management, analytics, settings
- **Email Inbound**: Auto ticket creation, sentiment analysis
- **AI Chat**: Context-aware suggestions, KB integration
- **Webhook**: Inbound emails create/update tickets

## Ticket Status Transitions
```
open → waiting (customer reply expected)
open → resolved (agent fixing issue)
open → closed (immediate resolution)
resolved → waiting (customer needs to confirm)
waiting → resolved (customer replied/confirmed)
any status → closed (final state)
```

## Agent Analytics
- **Response Time**: Avg time to first reply
- **Resolution Time**: Avg time to close ticket
- **CSAT Score**: Customer satisfaction (1-5)
- **Ticket Volume**: Tickets handled per period
- **Review Rating**: Avg review rating
- **Sentiment Trend**: % of positive/negative tickets

## Critical Rules
- NEVER mix `AuthContext` and `SupportAuthContext` - each has separate tokens and API clients
- NEVER expose internal agent notes to customers - use `type: 'external'` only for customer-visible messages
- ALWAYS check sentiment when ticket created from email
- ALWAYS enable review collection for closed tickets (if enabled in settings)
- ALWAYS validate that agent is member of assigned team before granting access
