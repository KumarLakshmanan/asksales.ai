# Customer Documents library

The Documents section lives under **Knowledge Base**, alongside Media Gallery. It manages customer-facing PDFs separately from knowledge-base answer sources.

## Upload and approve

1. Open **Knowledge Base → Documents → Add document**.
2. Add a clear title, a description of when the file should be shared, a topic, and the business/property scope. Upload a PDF up to 20 MB.
3. Save the draft. Drafts cannot be sent to customers.
4. Choose **Review and approve**, download and inspect every page, confirm accuracy and sharing rights, add an approval note, and optionally set an expiry date.
5. Approve the exact file. The stored SHA-256 checksum binds approval to its bytes.

The uploader checks PDF signature, size and ownership; it is not an antivirus or content-accuracy certification. Do not approve a document with uncertain prices, timings, terms or sharing rights.

## Automatic document discovery

After approval, agents can find the file automatically. There is no **Connect to playbooks** step and no per-file linking. Describe the intended audience, contents and exclusions clearly and choose the correct topic.

Existing **Share approved document** playbook nodes search the current approved library using their topic and the customer's request. AI validates relevance even when just one candidate exists. Older saved file IDs no longer restrict the search; a newly approved replacement can be selected without editing or republishing the playbook. Only a current authorized match can be sent. An explicit document request can also use the library without any playbook assignment.

When no approved document matches, the bot explains that and offers to connect the customer with support. It does not create a handoff unless the customer requests or accepts it. A lookup/provider failure instead says the documents could not be checked; it does not claim the library is empty. Ambiguous matches send no file.

Adding or approving a document does not publish playbook drafts, enable paused agents, or resume held conversations. New/edited playbook flows still use their normal publication workflow.

An explicit customer brochure request can also use the approved library through the existing read-only information route, without restarting intake or creating a proposal. Information requests do not authorize callbacks or collection of unrelated contact details.

A custom room/service proposal is different from an existing brochure. An explicit AI-classified proposal request selects the enabled published proposal journey for the active support specialist, even during unrelated booking/document intake. The prior run and its fields remain in the audit history with status `superseded`; no pending booking/callback is executed. Stated non-PII requirements accompany the proposal context when available. Missing proposal requirements are collected by that journey and the proposal agent prepares a customer-linked draft for seller review, never an automatically approved or sent offer.

## Replacement and withdrawal

Editing the title, description, topic, scope or PDF withdraws the old approval and saves a new draft. Review and approve again. Conflicting edits require refreshing; original files and audit records are retained.

Withdrawal stops new eligible automatic sends. Already-delivered messages cannot be recalled. Expired, withdrawn, deleted or checksum-mismatched files fail runtime delivery checks. Tenant/profile boundaries and conversation ownership/approval/opt-out gates still apply.

## Channel and knowledge boundaries

Customer document delivery supports WhatsApp (private approved files with durable provider delivery receipts) and the public support webchat widget (session-authorized PDF download cards). Owner advisory/preview chats do not deliver customer attachments.

Webchat checks the widget, team, session credential and expiry, and the exact assistant-message attachment. Each download rechecks the current approval and SHA-256 checksum against private storage; it does not expose a reusable public storage URL. Withdrawn or expired files can no longer be downloaded, including from older messages. Files already saved by a customer cannot be recalled. A persisted webchat attachment confirms that the file was offered in the chat, not that the customer downloaded or read it.

Raw retrieved excerpts are operator evidence and are not exposed in public webchat, including historical reads and request replays. Approved PDF attachments are a separate customer-sharing boundary. Seller review of a saved proposal does not automatically transfer the support conversation to a human.

An explicit proposal request in customer webchat may create a seller-review draft tied to that authenticated browser session. The server creates a separate draft-only lead and conversation on demand; it never matches a typed name/email to an existing customer's proposals. The session identity is **not verified contact identity**. Drafts have no outbound recipient email, do not send automatically and cannot be approved by the bot. The seller must verify the intended recipient, complete the commercial details, and approve before sending. Brochure-only requests do not create a lead or proposal; previews remain non-mutating.

Library descriptions support document selection, not factual answers extracted from PDF pages. To answer questions about prices or terms, maintain the approved knowledge-base sources separately. Never substitute the resort factsheet or day-outing brochure for a missing corporate, spa or menu document.

Deployment requires migrations 289 and 290 before the new API/worker/client release. The library routes use owner authentication; support-member tokens cannot publish or download owner-library files. New library approvals are explicit owner actions with revision/checksum guards and an audit trail.

For an existing hospitality account, `server/scripts/enable-automatic-support-documents.ts OWNER PLAYBOOK EXPECTED_VERSION` previews a scoped rollout. `--apply` publishes a new immutable version for the two brochure menu nodes and enables the account's three published proposal journeys/tools. Ownership, active version, unchanged drafts, assignments, and graph validation must pass. Other accounts and existing run snapshots are untouched. The audit records previous configuration for rollback.

The operator-only `approve-support-document.ts` command supports `--library --description ...` when importing an exact PDF already approved by its owner. The owner, file ID, topic, checksum, title, description and recorded approval reason are required; publication requires `--apply`. A matching published entry is a no-op, while an existing draft, withdrawn entry or differing publication requires manual review. This is not authority to approve additional files.
