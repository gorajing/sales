import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../db/schema';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('@/db', async () => {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve(dirname, '../../db/migrations') });
  return { db, schema };
});

beforeEach(async () => {
  const { db, schema: s } = await import('@/db');
  db.delete(s.gtmHandoffImports).run();
  db.delete(s.critiques).run();
  db.delete(s.touchRevisions).run();
  db.delete(s.touches).run();
  db.delete(s.sequences).run();
  db.delete(s.extractionAudits).run();
  db.delete(s.evidence).run();
  db.delete(s.callPrepBriefs).run();
  db.delete(s.deliverableAccounts).run();
  db.delete(s.deliverables).run();
  db.delete(s.contacts).run();
  db.delete(s.accounts).run();
});

import { importGtmHandoffPayload } from '../../lib/gtm-handoff/import';

const basePayload = {
  schemaVersion: 'gtm-ops-router.sales-handoff.v1',
  generatedAt: '2026-05-27T15:00:00.000Z',
  accounts: [
    {
      routerDealId: 'D-ryder',
      trace: {
        sourceSystem: 'gtm-ops-router',
        evidenceBoundary: 'research_seed_not_verified_evidence',
      },
      operatorLinks: {
        consoleUrl: 'http://localhost:8787/?deal=D-ryder',
        eventsUrl: 'http://localhost:8787/deals/D-ryder/events',
      },
      account: {
        name: 'Ryder Digital',
        domain: 'Ryder-Digital.com',
        region: 'NA',
        sourceChannel: 'inbound_form',
      },
      contact: {
        name: 'Dana Pruitt',
        email: 'dana@ryder-digital.com',
      },
      opportunity: {
        amountUsd: 120000,
        statedNeed: 'Manual after-hours check calls need automation.',
        route: {
          kind: 'human_assisted',
          salesOwner: 'ae.morgan',
          financeFlag: 'pricing_approval',
          legalFlag: 'regulated_review',
          queue: null,
          reason: null,
          slaHours: 4,
        },
        score: { total: 1, notes: ['painSignal=1.00'] },
      },
      workflow: {
        commercialState: null,
        deploymentReadiness: null,
        workItems: [],
        agentSuggestions: [],
      },
      enrichmentEvidence: {
        industry: 'logistics',
        employees: 1200,
        confidence: 0.95,
      },
      salesToolInput: {
        accountName: 'Ryder Digital',
        accountDomain: 'ryder-digital.com',
        researchBrief: 'Ryder Digital entered the GTM router from inbound_form.',
        suggestedEvidenceQuestions: [
          'Find public evidence of after-hours freight operations.',
          'Find current procurement or integration context.',
        ],
      },
    },
  ],
};

describe('GTM handoff import', () => {
  it('creates account, contact, and a non-evidence handoff record', async () => {
    const result = importGtmHandoffPayload(basePayload);

    expect(result).toMatchObject({
      processed: 1,
      accountsCreated: 1,
      contactsCreated: 1,
      handoffsCreated: 1,
    });

    const { db, schema: s } = await import('@/db');
    const accounts = db.select().from(s.accounts).all();
    const contacts = db.select().from(s.contacts).all();
    const handoffs = db.select().from(s.gtmHandoffImports).all();
    const evidence = db.select().from(s.evidence).all();

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      name: 'Ryder Digital',
      domain: 'ryder-digital.com',
      industry: 'logistics',
      size: '1200',
    });
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      accountId: accounts[0]?.id,
      fullName: 'Dana Pruitt',
      email: 'dana@ryder-digital.com',
    });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({
      routerDealId: 'D-ryder',
      accountId: accounts[0]?.id,
      routeKind: 'human_assisted',
      salesOwner: 'ae.morgan',
      amountUsd: 120000,
      sourceChannel: 'inbound_form',
    });
    expect(handoffs[0]?.suggestedEvidenceQuestionsJson).toEqual(
      basePayload.accounts[0].salesToolInput.suggestedEvidenceQuestions,
    );
    const storedPayload = JSON.parse(handoffs[0]?.payloadJson ?? '{}');
    expect(storedPayload.trace).toEqual({
      sourceSystem: 'gtm-ops-router',
      evidenceBoundary: 'research_seed_not_verified_evidence',
    });
    expect(storedPayload.operatorLinks).toEqual({
      consoleUrl: 'http://localhost:8787/?deal=D-ryder',
      eventsUrl: 'http://localhost:8787/deals/D-ryder/events',
    });
    expect(evidence).toHaveLength(0);
  });

  it('updates the handoff on replay without duplicating account or contact rows', async () => {
    importGtmHandoffPayload(basePayload);
    const replay = structuredClone(basePayload);
    replay.generatedAt = '2026-05-27T16:00:00.000Z';
    replay.accounts[0].opportunity.amountUsd = 150000;
    replay.accounts[0].salesToolInput.researchBrief = 'Updated router context.';

    const result = importGtmHandoffPayload(replay);

    expect(result).toMatchObject({
      processed: 1,
      accountsCreated: 0,
      contactsCreated: 0,
      contactsUpdated: 0,
      handoffsCreated: 0,
      handoffsUpdated: 1,
    });

    const { db, schema: s } = await import('@/db');
    expect(db.select().from(s.accounts).all()).toHaveLength(1);
    expect(db.select().from(s.contacts).all()).toHaveLength(1);
    const handoff = db.select().from(s.gtmHandoffImports).all()[0];
    expect(handoff.amountUsd).toBe(150000);
    expect(handoff.generatedAt).toBe('2026-05-27T16:00:00.000Z');
    expect(handoff.researchBrief).toBe('Updated router context.');
  });

  it('rejects unknown handoff schema versions', () => {
    expect(() =>
      importGtmHandoffPayload({ ...basePayload, schemaVersion: 'wrong.v1' }),
    ).toThrow();
  });

  it('rejects non-http operator links', () => {
    const payload = structuredClone(basePayload);
    payload.accounts[0].operatorLinks.consoleUrl = 'javascript:alert(1)';

    expect(() => importGtmHandoffPayload(payload)).toThrow();
  });
});
