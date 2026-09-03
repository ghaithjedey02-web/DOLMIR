# Privacy and data protection

**Status:** written against the code as it is on 2026-09-03. It describes the technical controls that exist and the decisions that still need a human, and legal, answer. Nothing here is a claim of compliance with any regulation.

## What the platform processes

DOLMIR ingests business communications on behalf of a customer company: e-mail messages, their attachments, and records the company imports about its customers, suppliers, contacts and products. These carry personal data as a matter of course, mostly names, business e-mail addresses, telephone numbers and signatures, and occasionally whatever a correspondent chose to write in a message body.

The customer company is the controller of that data. DOLMIR is a processor. Anthropic, as the model provider, is a sub-processor for the content that reaches a model. That chain has to be reflected in the customer contract before any real mailbox is connected; it is a legal deliverable, not a technical one.

## Controls that exist in the code

- **Tenant isolation.** Every table carries an organisation id, has Row-Level Security enabled and forced, and is reachable only inside a transaction that names the tenant. The runtime database role cannot bypass RLS and holds no DELETE grant. Integration tests assert that one tenant sees nothing of another, including connections, documents and ingestion nonces.
- **Credential protection.** Connector credentials are encrypted with AES-256-GCM under a deployment key, with the tenant id as associated data, so an envelope copied onto another tenant does not decrypt. Plaintext exists only inside the connectors module and the adapter it is handed to. No API path returns credentials, and the audit trail records which credential fields changed, never their values.
- **Access control.** Permissions are named constants resolved from a versioned role matrix. Reading connection metadata and managing connections are separate permissions, and managing them is human-only.
- **Auditability.** Ingestion, signature rejection, polling, connection changes, tool execution, approvals and actions all leave audit entries with actor, target and outcome. The audit log and the event ledger are append-only, enforced by database triggers against every role.
- **Data minimisation at the boundary.** Message metadata stored on a document is limited to routing and threading facts. Logs are redacted for secret-looking keys and personal data. Bodies are never logged.
- **Purpose limitation in the model boundary.** A model sees a document only through an analysis that a system requested; content reaches it wrapped as untrusted data, and it can act only through typed tools that check permissions.

## What is deliberately not built yet

- **Retention and deletion.** There is no retention schedule, no automated erasure and no per-subject deletion path. Documents, ledger events and audit entries accumulate. Ledger and audit are immutable by design, which is right for defensibility and directly in tension with an erasure request; reconciling the two is a decision, not an oversight. See the open questions below.
- **Export.** There is no per-tenant export endpoint. The data is in one PostgreSQL database and can be extracted by an operator, which is not the same as a product feature.
- **Data residency.** The deployment target is not chosen. Model calls go wherever the provider serves them.
- **Consent and notice.** Nothing in the platform informs a correspondent that their message is processed by an AI system. Whether notice is required, and who gives it, is the customer's obligation to determine.

## Open decisions that need human and legal review

1. **Erasure against an immutable ledger.** The likely answer is crypto-shredding or redaction of the payload while the event and its provenance survive, so the audit chain stays intact. It changes the ledger contract and must be decided before the first production customer.
2. **Retention periods** per class of data: raw messages, extracted text, cases, audit entries, AI usage records. Different periods are defensible; none is chosen.
3. **Sub-processor disclosure and the model provider's data handling terms**, including whether customer content may be used for training, which must be contractually excluded.
4. **Residency**, if a customer requires that data stay in the European Union, which constrains both the database and the model endpoint.
5. **Attachment handling of special categories.** A message can contain anything, including health or identity documents sent by mistake. There is no detection and no special handling today.
6. **The lawful basis** the customer relies on for analysing correspondence, and whether their own privacy notice covers it.

Until these have answers from the customer and their counsel, DOLMIR should be run against test mailboxes only.
