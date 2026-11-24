# Support Playbooks: Purpose and Usage Guide

## Purpose

Support playbooks define the approved conversation paths that AskSales support
agents follow when replying to customers. They turn support policies into
versioned, visual workflows so an agent does not need to improvise the next
step for common situations such as:

- hotel availability and booking questions;
- reservation, cancellation, refund, and payment-safety requests;
- technical troubleshooting and ticket-status checks;
- complaints and service recovery;
- lead qualification and sales handoff;
- FAQ responses grounded in approved knowledge;
- sensitive, unsafe, or high-risk requests that require a person.

A playbook does not replace the support agent. It adds deterministic instructions,
routing, compliance requirements, and escalation behavior around the agent. The
agent can still use conversation context and approved knowledge, but it must
follow the active playbook step and all mandatory platform controls.

## Where Playbooks Are Managed

### Platform administrator

Open:

`Admin → Support Playbooks`

The direct development URL is:

`https://dev.asksales.ai/admin/dashboard/support-playbooks`

Super administrators can:

- create platform playbook templates;
- visually arrange and connect conversation steps;
- edit instructions, branch rules, approved actions, and compliance phrases;
- assign playbooks to channels, intents, and support-agent types;
- configure deterministic A/B variants;
- publish, archive, and version templates;
- propagate changes to client accounts that still use the managed template.

Other administrators can inspect the complete configuration but cannot change
platform defaults.

### Client account

Client accounts can inspect and customize their provisioned playbooks from:

`Dashboard → Settings → Outreach → Playbooks`

A client edit applies only to that account. It changes the playbook from
`managed` to `customized`, which prevents later administrator updates from
overwriting the client's changes. The client can use **Reset to admin** to
restore the current administrator template and resume managed updates.

## Managed Template Lifecycle

1. A super administrator creates or updates a playbook template.
2. Saving the template validates the graph and increments its template version.
3. The new graph and routing assignments are propagated atomically to every
   client copy whose mode is still `managed`.
4. Each affected client receives a new immutable playbook version.
5. Client copies marked `customized` or `custom` are preserved.
6. New client accounts receive the current published templates during default
   support provisioning.

This inheritance model allows platform-wide improvements without removing a
client's ability to maintain account-specific support procedures.

## Visual Flow Editor

The visual editor follows the ConvoAI playbook concept. Each card represents a
conversation step, and directed connections determine what happens next.

### Building a flow

1. Select an existing template or choose **New template**.
2. Enter the template name, purpose, support-agent type, and status.
3. Open the **Flow editor** tab.
4. Add the required step types.
5. Drag cards to arrange the flow.
6. Drag from the bottom handle of one step to the top handle of another to
   create a connection.
7. Select a step or connection to edit it in the inspector.
8. Ensure the flow shows **Flow ready**.
9. Configure routing and optional variants.
10. Choose **Save and propagate**.

The first step is marked as the entry step. Every other step must be reachable
from it. A playbook must end in at least one **Complete** or **Escalation** step.

## Step Types

| Step type | Purpose | Typical use |
| --- | --- | --- |
| **Trigger** | Starts the playbook and immediately follows its outgoing connection. | Begin a booking, refund, complaint, or troubleshooting flow. |
| **Message** | Provides the approved instruction or response content for the AI. | Explain policy, availability, pricing, or the verified next step. |
| **Question** | Requires the AI to collect specific information from the customer. | Ask for dates, booking reference, error details, or desired resolution. |
| **Condition** | Selects a branch using rules attached to outgoing connections. | Route based on keywords or detected intent. |
| **Action** | Calls one approved tool with configured arguments. | Search the knowledge base, check ticket status, or perform an authorized lookup. |
| **Escalation** | Stops autonomous handling and initiates human handoff. | Payment risk, safety issue, unresolved complaint, low confidence, or explicit handoff request. |
| **Complete** | Marks the playbook run as complete. | Finish a resolved or fully answered interaction. |

## Step Properties

### Label

The label is the short name displayed on the visual canvas. Use a clear action
name such as `Collect booking dates`, `Explain refund policy`, or
`Escalate payment concern`.

### AI instruction

Message and question steps contain the instruction applied to the support
agent. Instructions should specify:

- what the agent should communicate;
- what information may be requested;
- which claims require verification;
- what the agent must not promise or expose;
- when the flow should escalate.

### Must say verbatim

Enable this only when the exact approved wording must appear in the reply. The
playbook engine records a compliance failure if the generated reply omits that
wording.

Use verbatim text sparingly. Policy disclosures, legally reviewed statements,
and explicit safety warnings are suitable. Normal conversational guidance is
usually better expressed as an instruction plus required phrases.

### Required phrases

Enter one phrase per line. The reply is checked for all configured phrases and
the compliance result is stored with the playbook run.

### Approved action

Action steps identify the approved tool name and a JSON object containing its
arguments. Runtime tool approval remains mandatory. A playbook cannot bypass
tool permissions or authorize an otherwise unavailable action.

## Branch Conditions

Select a connection to configure its rule.

| Rule | Behavior |
| --- | --- |
| `always` | Uses the connection without comparing a value. |
| `contains` | Matches when the latest user message contains the configured value. |
| `not_contains` | Matches when the latest user message does not contain the value. |
| `equals` | Matches when the normalized message equals the configured value. |
| `matches_intent` | Matches when the detected support intent equals the configured value. |

Condition and trigger steps must have at least one outgoing connection.
Avoid ambiguous branches that can match the same message at the same priority.
Always include a safe fallback path, normally an `always` connection or an
escalation step.

## Routing Assignments

A published playbook receives conversations only through an enabled routing
assignment.

Each assignment contains:

- **Channel**: Email, WhatsApp, Instagram, Facebook, web, or all channels.
- **Intent**: One supported intent or all intents.
- **Support agent**: The specialist responsible for the playbook. This must
  match the template's default support-agent type.
- **Priority**: Higher values are evaluated first when multiple assignments
  match the same conversation.
- **Traffic percentage**: Deterministic rollout percentage from 0 to 100.
- **Active status**: Disabled assignments receive no new conversations.

The selected specialist must also be active and enabled for the inbound channel.
An assignment cannot activate an otherwise disabled support agent.

### Supported agent types

| Agent | Primary responsibility |
| --- | --- |
| `hotel_sales` | Availability, rooms, pricing, reservations, booking changes, and safe payment guidance. |
| `tech_support` | Troubleshooting, product issues, integrations, and ticket status. |
| `lead_qualifier` | Qualification, product interest, demos, and sales handoff. |
| `customer_success` | Complaints, cancellations, refunds, retention, and service recovery. |
| `general_service` | Greetings, FAQs, triage, knowledge-grounded answers, and safe fallback. |

## A/B Variants

Variants split conversations between alternate entry paths using a stable hash,
so the same conversation remains in the same variant.

For every configured variant:

- use a unique variant name;
- select an existing entry step;
- assign a whole-number traffic weight from 0 to 100;
- make sure all variant weights total exactly 100%.

Use variants to compare approved scripts or qualification paths. Do not use
variants to weaken privacy, safety, PII redaction, handoff, or tool-approval
controls.

## Mandatory Controls

Every administrator template receives the following enforced metadata:

| Control | Required state | Effect |
| --- | --- | --- |
| Privacy | `enforced` | Applies privacy checks before the AI response is delivered. |
| PII redaction | `enforced` | Redacts configured personal and sensitive identifiers. |
| Safety | `enforced` | Applies policy and risk controls to inbound and outbound messages. |
| Human handoff | `enabled` | Allows the playbook or safety pipeline to transfer control to a person. |
| Tool approval | `required` | Prevents an action step from bypassing approved-tool checks. |

These controls are applied by the server when a template is saved. Editing
advanced JSON cannot disable them.

## Runtime Message Handling

For each inbound customer message, the support pipeline:

1. identifies the account, conversation, and channel;
2. applies privacy protection and PII handling;
3. detects intent, sentiment, urgency, and human-handoff risk;
4. selects the highest-priority enabled assignment that matches the channel,
   intent, agent type, and traffic bucket;
5. starts or resumes the immutable active playbook version;
6. resolves the current node and evaluates applicable branch conditions;
7. supplies the step instruction, approved action, and compliance requirements
   to the selected support agent;
8. applies confidence, safety, and tool-approval gates;
9. escalates when the step or pipeline requires a human;
10. records playbook progress and compliance before delivering the reply.

An active conversation continues on the playbook version with which it started.
Publishing a new version affects new runs without changing the historical
instructions attached to an existing run.

## Example: Hotel Reservation and Payment Safety

```text
Trigger: booking or payment intent
  → Question: collect dates, guests, and booking reference
  → Action: retrieve verified reservation or availability information
  → Condition: payment or identity risk detected?
      yes → Escalation: explain secure human handoff
      no  → Message: provide verified next step and approved payment guidance
  → Complete
```

Recommended routing:

- Agent: `hotel_sales`
- Channels: WhatsApp, Instagram, Facebook, email, and web as required
- Intents: `booking_request`, `availability_inquiry`, or `payment_inquiry`
- Traffic: 100% after validation
- Escalation: required for payment secrets, unsupported payment promises,
  identity uncertainty, or customer request for a person

## Example: Technical Troubleshooting

```text
Trigger: support request
  → Question: collect the product area, symptoms, and safe diagnostic details
  → Action: search approved troubleshooting knowledge
  → Condition: verified solution found?
      yes → Message: provide the approved troubleshooting steps
      no  → Escalation: create or transfer to a human support ticket
  → Complete
```

Do not request passwords, secret keys, payment-card details, or unnecessary
personal data during troubleshooting.

## Validation Rules

The editor and server reject a playbook when:

- a step ID is missing or duplicated;
- the entry step does not exist;
- a message or question has no instruction;
- an action has no approved action name;
- a connection references a missing step;
- a trigger or condition has no outgoing connection;
- a step cannot be reached from the entry step;
- trigger and condition steps form a non-waiting loop;
- no complete or escalation step exists;
- variant identifiers are duplicated;
- variant entry steps are missing;
- variant weights are invalid or do not total 100%;
- a routing channel, intent, or support-agent type is unsupported;
- assignment traffic or priority is outside the allowed range;
- an assignment's agent does not match the template's agent.

## Recommended Authoring Practices

1. Keep each playbook focused on one support outcome.
2. Use short labels and explicit instructions.
3. Ask only for the minimum information needed.
4. Use approved actions for factual lookups instead of asking the AI to guess.
5. Add an escalation path for uncertainty, safety, payment, and unresolved cases.
6. Prefer required phrases over full verbatim replies unless exact text is
   necessary.
7. Start new or changed routes with reduced traffic when operational risk is
   meaningful.
8. Test every branch and every supported channel before using 100% traffic.
9. Archive obsolete templates instead of repurposing them for a different intent.
10. Review client-customized copies separately because administrator propagation
    intentionally does not overwrite them.

## Advanced JSON

The **Advanced JSON** tab exposes the stored graph for exceptional fields or
troubleshooting. After editing, choose **Apply JSON** to load the definition back
into the visual flow.

The JSON editor is not a bypass:

- server-side graph validation still applies;
- routing assignments are validated separately;
- mandatory controls are restored during save;
- saving still creates a new version and follows managed-template propagation.

Use the visual editor for normal administration because it makes disconnected
steps, branch paths, routing, and compliance behavior easier to review.

## Operational Checklist

Before saving and propagating an administrator template:

- [ ] The correct support-agent type is selected.
- [ ] Every step is reachable from the entry step.
- [ ] Every condition has a safe fallback path.
- [ ] Message and question instructions use verified policy language.
- [ ] Sensitive requests have an escalation path.
- [ ] Action names and arguments use approved tools only.
- [ ] Required phrases and verbatim settings are intentional.
- [ ] Channel and intent assignments are correct.
- [ ] Assignment priority and traffic percentage are correct.
- [ ] Variant traffic totals 100%, if variants are enabled.
- [ ] The template status is `Published / live` only when it is ready for use.
- [ ] Managed-client propagation impact has been reviewed.
