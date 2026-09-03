import { readFile } from 'node:fs/promises';

import {
  ActorType,
  type CaseId,
  CaseIdSchema,
  type ConnectionId,
  FAKE_MAILBOX_PROVIDER,
  type OrganizationId,
  OrganizationIdSchema,
  UuidSchema,
  type TenantContext,
  entityRowsFromCsv,
} from '@dolmir/core';
import { COMMERCIAL_INBOX_SYSTEM_KEY, RULE_KEYS } from '@dolmir/system-commercial-inbox';

import type { Container } from '../composition/container.js';

/**
 * Commands that make the platform usable by hand: set a company up, push a
 * message in, look at what DOLMIR made of it, and decide on what it proposed.
 *
 * They are ordinary callers of the same use cases the HTTP API exposes. They
 * take no shortcut: the same evidence verification, the same policy and the
 * same approval gate apply, so what a person sees here is what the product
 * does.
 */
export type DemoOutput = (line: string) => void;

const DEMO_CUSTOMERS = [
  'kind;name;code;email;vat',
  'customer;Officine Meccaniche Rossi S.r.l.;C0042;acquisti@officine-rossi.it;IT01234567890',
  'customer;Brescia Impianti S.p.A.;C0100;ufficio.acquisti@brescia-impianti.it;IT09876543210',
  'customer;Tecnoservice Nord S.r.l.;C0177;ordini@tecnoservice-nord.it;',
  'supplier;Acciaierie Valtrompia S.p.A.;F0010;vendite@acciaierie-valtrompia.it;',
].join('\n');

const DEMO_PRODUCTS = [
  'kind;name;code',
  'product;Flangia tornita S355 DN250 PN16;FL-250',
  'product;Flangia tornita S355 DN100 PN16;FL-100',
  'product;Albero di trasmissione 42CrMo4 L1200;ALB-42-1200',
  'product;Piastra rettificata C45 500x300x20;PST-C45-500',
  'product;Boccola bronzo CuSn12 D60;BOC-60',
].join('\n');

export async function demoSeed(
  container: Container,
  options: { readonly slug: string; readonly ownerSubject: string },
  out: DemoOutput,
): Promise<void> {
  const provisioned = await container.tenancy.provision.execute({
    organization: { slug: options.slug, name: 'Alfa Meccanica S.r.l.' },
    owner: { authSubject: options.ownerSubject, displayName: 'Demo Owner' },
  });
  if (!provisioned.ok) throw provisioned.error;
  const organizationId = provisioned.value.organization.id;
  const owner: TenantContext = {
    organizationId,
    organizationSlug: options.slug,
    userId: provisioned.value.owner.id,
    roleKey: 'owner',
  };

  const imported = await container.entities.import.execute(
    organizationId,
    { type: ActorType.USER, id: owner.userId },
    {
      source: 'demo',
      rows: rowsOf(`${DEMO_CUSTOMERS}\n${DEMO_PRODUCTS.split('\n').slice(1).join('\n')}`),
    },
  );
  if (!imported.ok) throw imported.error;

  await container.transactions.withTenant(organizationId, async (scope) => {
    const profile = await container.workspace.configuration.updateProfile(
      scope,
      owner,
      {
        legalName: 'Alfa Meccanica S.r.l.',
        sector: 'Lavorazioni meccaniche di precisione e carpenteria',
        description:
          'Produce flange, alberi di trasmissione e componenti torniti su disegno per il settore oleodinamico.',
        languages: ['it', 'en'],
        signature: 'Ufficio Commerciale\nAlfa Meccanica S.r.l.\nvendite@alfa-meccanica.it',
      },
      options.slug,
    );
    if (!profile.ok) throw profile.error;
    for (const [key, value, why] of [
      ['reply_language', 'it', 'I clienti sono italiani.'],
      ['response_sla_hours', 24, 'Prima risposta entro un giorno lavorativo.'],
      [RULE_KEYS.QUOTATION_LEAD_TIME_DAYS, 3, 'Tempo tipico per un preventivo.'],
      [RULE_KEYS.ACKNOWLEDGE_QUOTE_REQUESTS, true, 'Confermiamo sempre la ricezione.'],
    ] as const) {
      const saved = await container.workspace.configuration.setRule(scope, owner, key, value, why);
      if (!saved.ok) throw saved.error;
    }
    for (const [term, meaning] of [
      ['RdO', 'Richiesta di offerta: il cliente chiede un preventivo.'],
      ['DN', 'Diametro nominale di una flangia, in millimetri.'],
      ['PN', 'Pressione nominale di una flangia, in bar.'],
    ] as const) {
      const saved = await container.workspace.configuration.upsertTerm(scope, owner, {
        term,
        meaning,
      });
      if (!saved.ok) throw saved.error;
    }
  });

  const mailbox = await container.connectors.manage.create(owner, {
    capability: 'mailbox',
    provider: container.config.mailbox.driver === 'fake' ? FAKE_MAILBOX_PROVIDER : 'imap_smtp',
    displayName: 'Vendite',
    settings:
      container.config.mailbox.driver === 'fake'
        ? { mailbox: 'INBOX' }
        : {
            imap: { host: 'imap.example.test', port: 993, secure: true },
            smtp: { host: 'smtp.example.test', port: 587, secure: false },
            mailbox: 'INBOX',
            from: 'vendite@alfa-meccanica.it',
          },
    credentials: { user: 'vendite@alfa-meccanica.it', pass: 'replace-me' },
  });
  if (!mailbox.ok) throw mailbox.error;

  const key = await container.connectors.manage.issueIngestionKey(owner, 'demo forwarder');
  if (!key.ok) throw key.error;

  out(
    JSON.stringify(
      {
        organizationId,
        slug: options.slug,
        ownerUserId: owner.userId,
        ownerAuthSubject: options.ownerSubject,
        entities: imported.value,
        mailboxConnectionId: mailbox.value.id,
        ingestion: { keyId: key.value.keyId, secret: key.value.secret },
        systems: container.cases.systems.list().map((system) => system.key),
      },
      null,
      2,
    ),
  );
  out('');
  out('The ingestion secret is shown once. Store it now; it cannot be read again.');
}

/** Ingests one `.eml` file and runs the analysis in the foreground, so the result is immediate. */
export async function demoSend(
  container: Container,
  options: { readonly organizationId: string; readonly file: string },
  out: DemoOutput,
): Promise<void> {
  const tenantId = OrganizationIdSchema.parse(options.organizationId);
  const raw = await readFile(options.file);
  const ingested = await container.connectors.ingestMessage.execute({
    tenantId,
    raw: Uint8Array.from(raw),
    sourceRef: `demo:${options.file}:${String(raw.byteLength)}`,
    actor: { type: ActorType.SERVICE, id: 'demo-cli' },
    recordedBy: 'cli.demo',
  });
  if (!ingested.ok) throw ingested.error;
  out(
    JSON.stringify(
      {
        documentId: ingested.value.document.id,
        duplicate: ingested.value.duplicate,
        subject: ingested.value.message.subject,
        from: ingested.value.message.from,
        attachments: ingested.value.attachments.map((item) => ({
          id: item.id,
          filename: item.filename,
          textStatus: item.textStatus,
        })),
      },
      null,
      2,
    ),
  );

  const report = await container.cases.analyze.execute(tenantId, ingested.value.document.id);
  if (!report.ok) throw report.error;
  out('');
  out(
    JSON.stringify(
      {
        analysed: report.value.opened.map((opened) => ({
          caseId: opened.case.id,
          kind: opened.case.kind,
          status: opened.case.status,
          determination: opened.case.determination,
          title: opened.case.title,
          findings: opened.findings.length,
          recommendations: opened.recommendations.map((item) => ({
            id: item.id,
            tool: item.tool,
            level: item.level,
          })),
        })),
        skipped: report.value.skipped,
        failed: report.value.failed,
      },
      null,
      2,
    ),
  );
}

export async function demoCases(
  container: Container,
  options: { readonly organizationId: string },
  out: DemoOutput,
): Promise<void> {
  const tenantId = OrganizationIdSchema.parse(options.organizationId);
  const cases = await container.transactions.withTenant(tenantId, (scope) =>
    container.cases.repository.listCases(scope, { limit: 50 }),
  );
  for (const item of cases) {
    out(
      `${item.id}  ${item.status.padEnd(18)} ${item.priority.padEnd(6)} ${item.determination.padEnd(17)} ${item.title}`,
    );
  }
  if (cases.length === 0) out('no cases yet');
}

export async function demoCase(
  container: Container,
  options: { readonly organizationId: string; readonly caseId: string },
  out: DemoOutput,
): Promise<void> {
  const tenantId = OrganizationIdSchema.parse(options.organizationId);
  const caseId: CaseId = CaseIdSchema.parse(options.caseId);
  const detail = await container.transactions.withTenant(tenantId, (scope) =>
    container.cases.engine.detail(scope, caseId),
  );
  if (detail === undefined) {
    out('case not found');
    return;
  }
  out(JSON.stringify(detail, null, 2));
}

/** Approves a recommendation as a named member and executes it, exactly as the API does. */
export async function demoDecide(
  container: Container,
  options: {
    readonly organizationId: string;
    readonly recommendationId: string;
    readonly userId: string;
    readonly decision: 'approved' | 'rejected';
    readonly note: string | null;
  },
  out: DemoOutput,
): Promise<void> {
  const tenantId: OrganizationId = OrganizationIdSchema.parse(options.organizationId);
  const recommendationId = UuidSchema.parse(options.recommendationId);
  const membership = await container.transactions.withTenant(tenantId, (scope) =>
    container.repositories.memberships.find(
      scope,
      tenantId,
      UuidSchema.parse(options.userId) as never,
    ),
  );
  if (membership === undefined) {
    out('that user is not a member of the organization');
    return;
  }
  const organization = await container.transactions.withTenant(tenantId, (scope) =>
    container.repositories.organizations.findById(scope, tenantId),
  );
  const tenant: TenantContext = {
    organizationId: tenantId,
    organizationSlug: organization?.slug ?? 'unknown',
    userId: membership.userId,
    roleKey: membership.roleKey,
  };
  const decided = await container.cases.engine.decide(
    tenant,
    recommendationId,
    options.decision,
    options.note,
  );
  if (!decided.ok) throw decided.error;
  out(JSON.stringify({ recommendation: decided.value }, null, 2));
  if (options.decision === 'rejected') return;

  const executed = await container.cases.engine.execute(tenantId, recommendationId);
  if (!executed.ok) throw executed.error;
  out('');
  out(JSON.stringify({ action: executed.value }, null, 2));
  const mailbox = container.connectors.mailboxes;
  if ('mailboxes' in mailbox && mailbox.mailboxes instanceof Map) {
    for (const [connectionId, box] of mailbox.mailboxes as Map<ConnectionId, { sent: unknown[] }>) {
      if (box.sent.length > 0) {
        out('');
        out(`messages the in-memory mailbox ${connectionId} has accepted:`);
        out(JSON.stringify(box.sent, null, 2));
      }
    }
  }
}

export const DEMO_SYSTEM_KEY = COMMERCIAL_INBOX_SYSTEM_KEY;

type ImportRow = Parameters<Container['entities']['import']['execute']>[2]['rows'][number];

function rowsOf(csv: string): ImportRow[] {
  const parsed = entityRowsFromCsv(csv);
  if (!parsed.ok) throw parsed.error;
  // The use case validates every row against its own schema and names the
  // first that does not fit, so a typo in the demo data fails loudly.
  return parsed.value as unknown as ImportRow[];
}
