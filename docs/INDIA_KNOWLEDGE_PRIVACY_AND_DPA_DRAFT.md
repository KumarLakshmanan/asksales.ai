# India Knowledge Privacy, Notice, and DPA Draft

> Legal status: implementation draft only. Do not publish or treat this file as legal advice. Indian privacy counsel must approve the final allocation of Data Fiduciary/Data Processor roles, notices, retention periods, cross-border posture, and effective dates.

## Product role allocation

- For tenant-uploaded knowledge, end-customer conversations, CRM data, and tenant-defined support purposes, the tenant acts as Data Fiduciary and the platform processes that data on the tenant's documented instructions.
- For platform accounts, billing, fraud prevention, service security, abuse prevention, and platform telemetry, the platform acts as an independent Data Fiduciary.
- Contracts and public notices must describe mixed-role processing per purpose rather than assigning one role to every activity.

## Required public privacy notice sections

1. Itemized personal-data categories and specific processing purposes.
2. AI retrieval, de-identified embeddings, automated assistance, human review, and the provider no-training commitment.
3. Tenant and platform role allocation.
4. Subprocessors, processing locations, cross-border processing, and change notices.
5. Purpose-specific retention and deletion schedules.
6. Access, correction, erasure, consent withdrawal, grievance, and nomination procedures.
7. Security measures and breach-contact details.
8. Children's-data prohibition unless an approved use case and verifiable parental-consent controls are in place.

## Knowledge-upload certification

Before publication, a tenant certifies that it has lawful authority and source rights; has minimized personal data; has not uploaded credentials, payment/authentication secrets, unrestricted customer exports, or unlawfully obtained material; has checked accuracy, audience, product/profile scope, authority, effective dates, and retention; and will correct or withdraw stale content.

## Minimum tenant DPA terms

- documented instructions and purpose limitation;
- confidentiality and personnel access controls;
- approved subprocessors, regions, change notice, and transfer posture;
- encryption, key rotation, least privilege, immutable access evidence, and backup testing;
- incident notification and cooperation;
- assistance with access, correction, erasure, grievance, and nomination requests;
- deletion from originals, versions, chunks, embeddings, caches, traces, backups, and processor copies;
- audit support and termination/return obligations;
- no model training on tenant or end-customer data.

## Engineering retention baseline

- PII-free retrieval diagnostics: 30 days by default.
- Security and access evidence: 365 days in India, subject to counsel confirmation and any stricter contractual/legal hold.
- Full document and message bodies: only for their documented operational purpose and configured retention; never as routine diagnostic logs.
- Tenant/DSAR deletion cascades to originals, versions, chunks, embeddings, caches, retrieval traces, and processor copies.

## Provider admission checklist

An embedding, reranking, OCR, or LLM provider must have an approved processing agreement; declared region and subprocessors; a no-training commitment; bounded retention; deletion support; suitable transfer posture; and verified behavior for incident and rights-request assistance.

## Primary legal sources for counsel review

- Digital Personal Data Protection Act, 2023: https://www.indiacode.nic.in/handle/123456789/22037
- Digital Personal Data Protection Rules, 2025: https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa
- Official commencement schedule: https://www.meity.gov.in/static/uploads/2025/11/c56ceae6c383460ca69577428d36828b.pdf
- CERT-In directions under section 70B: https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf

## Release gate

The `privacy-policy`, `data-processing-addendum`, and `knowledge-upload-certification` slugs must remain unpublished until `counsel_approved_at` is recorded. Application administrators cannot bypass this gate through the ordinary policy editor.
