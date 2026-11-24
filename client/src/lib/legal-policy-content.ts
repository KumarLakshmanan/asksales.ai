import { BRAND_NAME, COMPANY_NAME, SUPPORT_EMAIL } from "@/lib/brand";

export interface LegalPolicyFallback {
  title: string;
  summary: string;
  updatedAt: string;
  contentMarkdown: string;
}

export const LEGAL_POLICY_FALLBACKS: Record<string, LegalPolicyFallback> = {
  "privacy-policy": {
    title: "Privacy Policy",
    summary: `How ${COMPANY_NAME} and ${BRAND_NAME} collect, use, store, and protect information across the website, workspace, agents, and connected providers.`,
    updatedAt: "2026-08-21",
    contentMarkdown: `
## Overview

This Privacy Policy explains how ${BRAND_NAME} ("AskSales", "we", "us", or "our"), a product of ${COMPANY_NAME}, handles personal information when you visit our public website, create an account, use the campaign workspace, interact with an AI agent, connect an external service, or contact support. It also explains the choices and controls available to you.

AskSales is designed as a business sales and marketing workspace. Customers decide which business data, contacts, content, and provider accounts they connect. We process that information to deliver the requested service and do not sell personal information.

## Information we collect

We collect account information such as your name, business email address, authentication records, role, company details, and workspace preferences. When you use the product, we process prompts, conversation messages, campaign settings, lead-selection records, uploaded files, creative assets, approval decisions, and workflow status.

Connected services may provide account identifiers, page or advertising account metadata, delivery receipts, campaign performance data, and authorization tokens. Payment providers send us transaction status and limited billing metadata; complete card details are handled by the payment provider.

We also collect technical information including IP address, browser and device characteristics, timestamps, security events, feature usage, error logs, and diagnostic identifiers such as thread, run, and action IDs.

## How we use information

We use information to authenticate users, operate workspaces, generate requested content, find and reconcile leads, prepare outreach, create campaign drafts, send approved actions to configured providers, and display durable results. We also use it to prevent fraud, protect accounts, troubleshoot failures, improve reliability, provide support, and comply with legal obligations.

AI inputs are used to produce the output requested by the customer. Provider processing is limited to the capabilities configured for the relevant workflow. AskSales does not treat a queued action as sent, delivered, published, or active until the applicable durable record or provider receipt supports that state.

## AI agents and automated processing

AI agents can analyze customer-provided context and recommend or prepare actions. Material actions—such as contacting selected leads or activating advertising spend—are governed by workflow prerequisites and approval controls. Customers remain responsible for reviewing audiences, claims, creative, destinations, budgets, and legal requirements before approval.

AI outputs may be inaccurate or incomplete. Do not submit sensitive personal information unless it is necessary for the authorized business purpose, and review generated material before using it externally.

## Connected services and providers

When you connect services such as Google, Meta, email, messaging, storage, or lead-data providers, we exchange only the information needed to perform the requested integration. Those providers process information under their own terms and privacy notices.

You can disconnect an integration from workspace settings. Disconnecting stops new provider requests but does not automatically remove records already created at that provider. Provider-side deletion must be completed in the provider account when applicable.

## Legal bases and business roles

Depending on your location and the activity, we process information to perform a contract, pursue legitimate interests, comply with law, or act on consent. For customer contact and campaign data, the customer generally determines the purpose and means of processing, and AskSales acts as a service provider or processor.

Customers must have a lawful basis for uploading, enriching, selecting, or contacting individuals and must respect applicable marketing, privacy, and communications rules.

## Sharing and disclosure

We share information with infrastructure, security, analytics, AI, storage, payment, communications, and integration providers that help operate AskSales. Access is limited by purpose and contractual safeguards. We may also disclose information when required by law, to protect rights or safety, during a corporate transaction, or at the customer's direction.

We do not sell personal information or share it for cross-context behavioral advertising.

## Retention and deletion

We retain account and workspace information for as long as the account is active or as needed to provide the service. Workflow history, approvals, provider receipts, financial records, and security logs may be retained longer when necessary for audit, dispute, fraud-prevention, tax, or legal purposes.

You can request account deletion from the account-deletion page. We will delete or de-identify eligible information after verifying the request, subject to legal and operational retention requirements. Backups age out according to our backup lifecycle.

## Security

We use access controls, encryption in transit, protected credential storage, tenant scoping, logging, and operational monitoring designed to safeguard information. No system can guarantee absolute security. Customers should use unique passwords, protect administrator accounts, review connected providers, and promptly report suspected misuse.

## International transfers

AskSales and its service providers may process information in countries other than the one where it was collected. Where required, we use contractual and organizational safeguards for international transfers.

## Your choices and rights

Depending on your location, you may request access, correction, deletion, portability, restriction, or objection. You may also withdraw consent where consent is the processing basis. Workspace administrators can correct many account and business-profile fields directly.

To exercise a privacy right, email **${SUPPORT_EMAIL}** with enough information to verify and scope the request. We may ask for additional verification and may decline or limit a request where permitted by law.

## Children

AskSales is a business service and is not directed to children. We do not knowingly collect personal information from children below the age required to consent to data processing in their jurisdiction.

## Changes and contact

We may update this policy as the product, providers, or legal requirements change. The updated date shown on this page identifies the current version. Material changes may also be communicated through the workspace or by email.

Questions about privacy can be sent to **${SUPPORT_EMAIL}**.
`,
  },
  "terms-of-use": {
    title: "Terms of Use",
    summary: "The rules governing access to AskSales, customer responsibilities, approvals, providers, billing, and acceptable use.",
    updatedAt: "2026-08-21",
    contentMarkdown: `
## Agreement to these terms

These Terms of Use form an agreement between you and AskSales.AI when you access the website, create an account, or use the workspace. If you use AskSales for an organization, you confirm that you have authority to bind that organization. If you do not agree, do not use the service.

## The AskSales service

AskSales provides tools for lead generation, content creation, outreach preparation, campaign management, performance analysis, support operations, and integrations with external providers. Features may change as we improve the service. Some capabilities require a paid plan, configured provider account, available credits, approval, or a feature gate.

## Accounts and workspace access

You must provide accurate registration information, protect credentials, and keep account roles current. You are responsible for activity performed through your account and for promptly notifying us about suspected unauthorized access. Shared credentials are not permitted where individual member accounts are available.

Administrators control workspace membership, integrations, approvals, and business settings. Removing a member does not reverse actions already approved or completed through connected providers.

## AI-generated material

AI output may be inaccurate, incomplete, or unsuitable for a particular audience. You must review facts, claims, targeting, tone, intellectual-property considerations, and regulatory requirements before using generated material. AskSales does not provide legal, financial, medical, or professional advice.

You retain responsibility for prompts and customer-provided content. Subject to these terms, you may use generated output for your business. Similar output may be generated for other customers, and we do not guarantee exclusivity.

## Leads, outreach, and advertising

You may use AskSales only with a lawful basis and appropriate permissions. You are responsible for do-not-contact obligations, consent, suppression lists, platform rules, advertising disclosures, destination claims, budgets, and applicable communications laws.

Approval of an outreach or advertising review authorizes the specific action and fields shown in that review. Provider delivery and activation can still fail or be gated. A workflow state marked queued is not a representation that a message was sent or an ad became active.

## Connected providers

External services are governed by their own terms, policies, availability, and account requirements. You authorize AskSales to exchange data and submit actions to a connected provider when you request or approve that action. We are not responsible for provider suspensions, policy decisions, outages, pricing changes, or data retained in a provider account.

## Acceptable use

You may not use AskSales to violate law, infringe rights, deceive recipients, distribute malware, bypass provider controls, generate abusive or discriminatory content, scrape prohibited sources, send unlawful unsolicited communications, impersonate another person, or interfere with the service.

You may not probe for vulnerabilities, reverse engineer protected service components, evade usage limits, resell access without permission, or use automated means that materially degrade the service.

## Billing, credits, and taxes

Paid plans, usage credits, and provider costs are described at purchase. Unless stated otherwise, fees are charged in advance and usage-based charges are calculated from recorded events. You are responsible for applicable taxes and for maintaining a valid payment method.

Provider advertising spend, messaging charges, data-provider costs, and other third-party fees may be billed separately by those providers.

## Intellectual property

AskSales and its licensors own the service, software, visual system, documentation, trademarks, and related intellectual property. These terms grant a limited, non-exclusive, non-transferable right to use the service during the subscription term.

You retain ownership of customer content and grant AskSales the rights needed to host, process, transmit, and display it to provide and secure the service.

## Confidentiality and data

Each party may receive non-public business information from the other. The receiving party will use reasonable care to protect it and will use it only for the agreement, except where disclosure is required by law or the information is already public through no breach.

## Suspension and termination

We may suspend access to protect the service, comply with law, address non-payment, investigate misuse, or prevent harm. You may stop using AskSales and request account closure. Provisions that by their nature should survive termination—including payment, ownership, disclaimers, and liability limits—will survive.

## Disclaimers

The service is provided on an "as available" basis to the extent permitted by law. We do not guarantee uninterrupted operation, specific lead volume, campaign performance, provider approval, delivery, ranking, revenue, or business outcomes.

## Limitation of liability

To the maximum extent permitted by law, neither party will be liable for indirect, incidental, special, consequential, or punitive damages, or for lost profits, data, goodwill, or business opportunity. Any aggregate liability will be limited as stated in the applicable order or, if none is stated, to the fees paid for the service during the twelve months before the event giving rise to the claim.

## Changes, governing terms, and contact

We may update these terms to reflect product or legal changes. Continued use after the effective date constitutes acceptance where permitted by law. If an order form conflicts with these terms, the order form controls for that customer.

Questions about these terms can be sent to **${SUPPORT_EMAIL}**.
`,
  },
  "refund-policy": {
    title: "Refund Policy",
    summary: "When subscription fees or credits may be refunded, what is excluded, and how to request a billing review.",
    updatedAt: "2026-08-21",
    contentMarkdown: `
## Scope

This Refund Policy applies to fees paid directly to AskSales for subscriptions, workspace plans, and AskSales usage credits. It does not apply to charges collected by external providers such as advertising platforms, messaging providers, lead-data vendors, payment processors, or app marketplaces.

## Subscription charges

Subscription fees are generally non-refundable once a billing period begins because workspace access and plan capacity become available immediately. If you believe a charge was made in error, contact us within seven days of the charge so we can review the account and transaction.

Where consumer law provides a mandatory cancellation or refund right, that right applies regardless of this policy.

## Usage credits

Unused prepaid AskSales credits may be eligible for review when they were purchased in error and no portion of that credit purchase has been consumed. Credits used for completed or attempted provider-backed work are not refundable once the underlying cost has been incurred.

Promotional, bonus, trial, expired, or complimentary credits have no cash value and are not refundable or transferable.

## Duplicate and unauthorized charges

We will investigate duplicate charges and verified unauthorized transactions. Before filing a payment dispute, contact **${SUPPORT_EMAIL}** so we can identify the transaction, secure the account, and resolve a confirmed billing error.

## Service incidents

A temporary outage, provider failure, feature gate, or workflow error does not automatically create a refund. We may provide a service credit when a material AskSales-controlled incident substantially prevented use of a paid feature. Provider outages and provider-account restrictions are outside our control.

## Third-party costs

Advertising spend, email or messaging charges, data acquisition, cloud storage, and other provider costs are governed by the provider that charged them. AskSales cannot refund charges made directly by another company, even when the action was initiated from the AskSales workspace.

## Annual and prepaid plans

Annual or prepaid commitments are discounted in exchange for the commitment period and are normally non-refundable after activation. If an order form includes different refund rights, the order form controls.

## Requesting a review

Send a request to **${SUPPORT_EMAIL}** from the account owner's email address. Include the workspace name, invoice or transaction ID, charge date, amount, and a concise explanation. Do not send complete card details or passwords.

We may request identity or account verification. Refund reviews are usually completed within ten business days, although payment-provider investigations may take longer.

## Approved refunds

Approved refunds are returned to the original payment method where possible. Bank and payment-provider processing times vary and may take additional business days after AskSales releases the refund. Currency conversion and bank fees are controlled by the financial institution.

## Plan changes and credits

Upgrades take effect as described at checkout. Downgrades usually apply at the next renewal. Unless required by law or stated in an order form, unused time from a downgrade is not converted to cash. We may apply an account credit instead of a cash refund when appropriate and accepted by the customer.

## Abuse and exceptions

We may deny requests involving policy abuse, repeated refund patterns, fraudulent activity, consumed services, or material violation of the Terms of Use. We may make exceptions at our discretion without creating an obligation to make the same exception later.

## Changes and contact

We may update this policy as plans, providers, or legal requirements change. Questions and refund-review requests can be sent to **${SUPPORT_EMAIL}**.
`,
  },
  "cancellation-policy": {
    title: "Cancellation Policy",
    summary: "How to stop renewal, what remains available after cancellation, and what happens to data, credits, and provider campaigns.",
    updatedAt: "2026-08-21",
    contentMarkdown: `
## Cancelling a subscription

Workspace owners can cancel a subscription from billing settings or by contacting **${SUPPORT_EMAIL}** from the owner email address. Cancellation stops the next automatic renewal; it does not normally reverse the current billing period.

## Effective date

Unless the cancellation screen states otherwise, paid access continues until the end of the current billing period. The workspace then moves to the available free, restricted, or closed state. You can continue using included features until the effective date, subject to plan limits.

## Before you cancel

Review active outreach, scheduled work, advertising campaigns, provider connections, exports, and member access. Cancellation of AskSales does not automatically pause or delete campaigns, messages, automations, or billing configured directly at an external provider.

## Scheduled and queued actions

Cancel or pause scheduled actions before the subscription ends. Work already sent to a provider may continue according to the provider's state. AskSales will not describe queued work as sent, delivered, published, or active without the corresponding durable status or provider receipt.

## Credits and balances

Unused subscription allowances expire according to the plan. Purchased AskSales credits remain subject to their stated expiration and the Refund Policy. Promotional and trial credits may expire immediately when the associated plan or trial ends.

Outstanding fees, usage charges, provider costs, and taxes remain payable after cancellation.

## Data access and export

Before the effective date, export information you need to retain. After cancellation, access may be limited. We may retain workspace data for a limited recovery period and then delete or de-identify it, subject to backups, legal obligations, security records, provider receipts, and financial retention requirements.

## Connected providers

Disconnecting or cancelling AskSales does not terminate your agreement with Google, Meta, email, messaging, lead-data, storage, or other providers. You must manage provider subscriptions, campaigns, credentials, and retained data directly with those providers.

## Reactivation

If the workspace remains within the recovery period, the owner may reactivate by selecting an available plan and resolving outstanding balances. We do not guarantee that deleted data, expired credits, prior pricing, integrations, or provider authorizations can be restored.

## Trials

You can cancel a trial before its stated end date to avoid conversion to a paid plan when automatic conversion applies. Trial access and promotional credits may end immediately or at the trial expiration shown in billing settings.

## Annual commitments

Cancelling an annual commitment stops renewal at the end of the commitment term. Early cancellation does not normally create a prorated refund unless an order form or applicable law says otherwise.

## Account deletion

Subscription cancellation and account deletion are different actions. Cancellation stops renewal. Account deletion requests removal of eligible account and workspace data. Use the account-deletion page if you also want to request deletion.

## Changes and contact

We may update this policy when plan and billing operations change. For cancellation assistance, contact **${SUPPORT_EMAIL}** and include the workspace name. Never include your password or complete payment-card details.
`,
  },
};

export function getLegalPolicyFallback(slug: string, fallbackTitle: string): LegalPolicyFallback {
  return LEGAL_POLICY_FALLBACKS[slug] || {
    title: fallbackTitle,
    summary: "Important information about using AskSales.",
    updatedAt: "2026-08-21",
    contentMarkdown: `## Overview\n\nPlease contact ${SUPPORT_EMAIL} for the current policy.`,
  };
}
