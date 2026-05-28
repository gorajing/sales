import fs from 'node:fs';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { newId } from '@/lib/id';
import { isSafeHttpUrl } from './trace';

export const GTM_HANDOFF_SCHEMA_VERSION = 'gtm-ops-router.sales-handoff.v1';

const RouteKind = z.enum(['human_assisted', 'self_serve', 'nurture']);
const EvidenceBoundary = z.literal('research_seed_not_verified_evidence');
// Shared rule with the account-page render sink (lib/gtm-handoff/trace.ts).
const SafeHttpUrl = z.string().refine(
  (value) => isSafeHttpUrl(value) !== null,
  'operator links must use http or https',
);

const GtmHandoffAccount = z.object({
  routerDealId: z.string().min(1),
  // Optional for backward compatibility: a minimal or pre-trace v1 export may
  // omit this block. Absence is safe — the research-seed boundary is enforced
  // structurally by the evidence layer (only verified rows are citable) and the
  // account page shows the "not verified evidence" notice regardless. When
  // present, the values must still match the router's contract literals.
  trace: z.object({
    sourceSystem: z.literal('gtm-ops-router'),
    evidenceBoundary: EvidenceBoundary,
  }).passthrough().optional(),
  operatorLinks: z.object({
    consoleUrl: SafeHttpUrl,
    eventsUrl: SafeHttpUrl,
  }).passthrough().optional(),
  account: z.object({
    name: z.string().min(1),
    domain: z.string().nullable(),
    region: z.string(),
    sourceChannel: z.string().min(1),
  }),
  contact: z.object({
    name: z.string().min(1),
    email: z.string().email(),
  }),
  opportunity: z.object({
    amountUsd: z.number().int().nonnegative(),
    statedNeed: z.string().min(1),
    route: z.object({
      kind: RouteKind,
      salesOwner: z.string().nullable(),
      financeFlag: z.string().nullable(),
      legalFlag: z.string().nullable(),
      queue: z.string().nullable(),
      reason: z.string().nullable(),
      slaHours: z.number().nullable(),
    }).passthrough(),
    score: z.object({
      total: z.number(),
      notes: z.array(z.string()),
    }).passthrough(),
  }),
  workflow: z.object({
    commercialState: z.string().nullable(),
    deploymentReadiness: z.unknown().nullable(),
    workItems: z.array(z.unknown()),
    agentSuggestions: z.array(z.unknown()),
  }).passthrough(),
  enrichmentEvidence: z.object({
    industry: z.string(),
    employees: z.number().int().nonnegative(),
    confidence: z.number(),
  }).passthrough().nullable(),
  salesToolInput: z.object({
    accountName: z.string().min(1),
    accountDomain: z.string().nullable(),
    researchBrief: z.string().min(1),
    suggestedEvidenceQuestions: z.array(z.string().min(1)),
  }),
}).passthrough();

const GtmHandoffPayload = z.object({
  schemaVersion: z.literal(GTM_HANDOFF_SCHEMA_VERSION),
  generatedAt: z.string().min(1),
  accounts: z.array(GtmHandoffAccount),
}).passthrough();

export type GtmHandoffPayload = z.infer<typeof GtmHandoffPayload>;
export type GtmHandoffAccount = z.infer<typeof GtmHandoffAccount>;

export interface GtmHandoffImportResult {
  schemaVersion: typeof GTM_HANDOFF_SCHEMA_VERSION;
  generatedAt: string;
  processed: number;
  accountsCreated: number;
  accountsUpdated: number;
  contactsCreated: number;
  contactsUpdated: number;
  handoffsCreated: number;
  handoffsUpdated: number;
  imported: Array<{
    routerDealId: string;
    accountId: string;
    accountName: string;
    contactId: string;
  }>;
}

function normalizeDomain(domain: string | null | undefined): string | undefined {
  if (!domain) return undefined;
  const cleaned = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
  return cleaned || undefined;
}

function researchSeedNotes(account: GtmHandoffAccount): string {
  return [
    `GTM router deal: ${account.routerDealId}`,
    `Route: ${account.opportunity.route.kind}`,
    account.opportunity.route.salesOwner
      ? `Owner: ${account.opportunity.route.salesOwner}`
      : null,
    `Research seed: ${account.salesToolInput.researchBrief}`,
  ].filter(Boolean).join('\n');
}

function mergeNotes(existing: string | null, addition: string): string {
  if (!existing || existing.trim().length === 0) return addition;
  if (existing.includes(addition)) return existing;
  return `${existing.trim()}\n\n${addition}`;
}

export function parseGtmHandoffPayload(raw: unknown): GtmHandoffPayload {
  return GtmHandoffPayload.parse(raw);
}

export function importGtmHandoffPayload(raw: unknown): GtmHandoffImportResult {
  const payload = parseGtmHandoffPayload(raw);
  const result: GtmHandoffImportResult = {
    schemaVersion: GTM_HANDOFF_SCHEMA_VERSION,
    generatedAt: payload.generatedAt,
    processed: 0,
    accountsCreated: 0,
    accountsUpdated: 0,
    contactsCreated: 0,
    contactsUpdated: 0,
    handoffsCreated: 0,
    handoffsUpdated: 0,
    imported: [],
  };

  db.transaction((tx) => {
    for (const item of payload.accounts) {
      const domain = normalizeDomain(item.account.domain ?? item.salesToolInput.accountDomain);
      const existingHandoff = tx.select().from(schema.gtmHandoffImports)
        .where(eq(schema.gtmHandoffImports.routerDealId, item.routerDealId)).get();
      let account = existingHandoff
        ? tx.select().from(schema.accounts)
            .where(eq(schema.accounts.id, existingHandoff.accountId)).get()
        : undefined;

      if (!account && domain) {
        account = tx.select().from(schema.accounts)
          .where(eq(schema.accounts.domain, domain)).get();
      }

      if (!account) {
        account = tx.select().from(schema.accounts)
          .where(eq(schema.accounts.name, item.account.name)).get();
      }

      let accountId: string;
      if (account) {
        accountId = account.id;
        const accountPatch: {
          name?: string;
          domain?: string;
          industry?: string;
          size?: string;
          notes?: string;
        } = {};
        if (!account.domain && domain) accountPatch.domain = domain;
        if (!account.industry && item.enrichmentEvidence?.industry) {
          accountPatch.industry = item.enrichmentEvidence.industry;
        }
        if (!account.size && item.enrichmentEvidence?.employees !== undefined) {
          accountPatch.size = String(item.enrichmentEvidence.employees);
        }
        if (!account.notes) accountPatch.notes = researchSeedNotes(item);
        if (Object.keys(accountPatch).length > 0) {
          tx.update(schema.accounts).set(accountPatch)
            .where(eq(schema.accounts.id, accountId)).run();
          result.accountsUpdated += 1;
        }
      } else {
        accountId = newId('account');
        tx.insert(schema.accounts).values({
          id: accountId,
          name: item.account.name,
          domain,
          industry: item.enrichmentEvidence?.industry,
          size: item.enrichmentEvidence?.employees === undefined
            ? undefined
            : String(item.enrichmentEvidence.employees),
          notes: researchSeedNotes(item),
        }).run();
        result.accountsCreated += 1;
      }

      const existingContact = tx.select().from(schema.contacts)
        .where(and(
          eq(schema.contacts.accountId, accountId),
          eq(schema.contacts.email, item.contact.email),
        )).get();

      let contactId: string;
      if (existingContact) {
        contactId = existingContact.id;
        const contactNotes = `GTM router source deal: ${item.routerDealId}`;
        const contactPatch: { fullName?: string; notes?: string } = {};
        if (existingContact.fullName !== item.contact.name) {
          contactPatch.fullName = item.contact.name;
        }
        const nextNotes = mergeNotes(existingContact.notes, contactNotes);
        if (nextNotes !== existingContact.notes) contactPatch.notes = nextNotes;
        if (Object.keys(contactPatch).length > 0) {
          tx.update(schema.contacts).set(contactPatch)
            .where(eq(schema.contacts.id, contactId)).run();
          result.contactsUpdated += 1;
        }
      } else {
        contactId = newId('contact');
        tx.insert(schema.contacts).values({
          id: contactId,
          accountId,
          fullName: item.contact.name,
          email: item.contact.email,
          archetype: 'unknown',
          notes: `GTM router source deal: ${item.routerDealId}`,
        }).run();
        result.contactsCreated += 1;
      }

      const existingImport = tx.select().from(schema.gtmHandoffImports)
        .where(eq(schema.gtmHandoffImports.routerDealId, item.routerDealId)).get();
      const handoffValues = {
        accountId,
        schemaVersion: payload.schemaVersion,
        generatedAt: payload.generatedAt,
        accountName: item.account.name,
        accountDomain: domain,
        routeKind: item.opportunity.route.kind,
        salesOwner: item.opportunity.route.salesOwner,
        amountUsd: item.opportunity.amountUsd,
        sourceChannel: item.account.sourceChannel,
        researchBrief: item.salesToolInput.researchBrief,
        suggestedEvidenceQuestionsJson: item.salesToolInput.suggestedEvidenceQuestions,
        payloadJson: JSON.stringify(item),
      };

      if (existingImport) {
        tx.update(schema.gtmHandoffImports).set(handoffValues)
          .where(eq(schema.gtmHandoffImports.routerDealId, item.routerDealId)).run();
        result.handoffsUpdated += 1;
      } else {
        tx.insert(schema.gtmHandoffImports).values({
          routerDealId: item.routerDealId,
          ...handoffValues,
        }).run();
        result.handoffsCreated += 1;
      }

      result.imported.push({
        routerDealId: item.routerDealId,
        accountId,
        accountName: item.account.name,
        contactId,
      });
      result.processed += 1;
    }
  });

  return result;
}

export function importGtmHandoffFile(path: string): GtmHandoffImportResult {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8')) as unknown;
  return importGtmHandoffPayload(raw);
}
