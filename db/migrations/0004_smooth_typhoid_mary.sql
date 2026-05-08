-- 0003 had case-sensitive partial unique indexes on accounts.domain and
-- contacts.email (WHERE x IS NOT NULL). 0004 replaces them with case-
-- insensitive (lower()) versions that also exclude empty strings.
--
-- Order matters here: drop the OLD indexes first, then normalize, then create
-- the NEW indexes. If we normalized first, an UPDATE that turns '   ' into ''
-- could hit a UNIQUE collision on the OLD index (two rows with '') that the
-- new index would correctly allow (because '' is excluded). Reordering makes
-- normalization fail-free for cases the new schema considers valid.
DROP INDEX `accounts_domain_unique`;--> statement-breakpoint
DROP INDEX `contacts_email_unique`;--> statement-breakpoint
UPDATE `accounts` SET `domain` = lower(trim(`domain`)) WHERE `domain` IS NOT NULL AND `domain` <> '';--> statement-breakpoint
UPDATE `contacts` SET `email` = lower(trim(`email`)) WHERE `email` IS NOT NULL AND `email` <> '';--> statement-breakpoint
-- If normalization produced TRUE lowercase duplicates (e.g. 'acme.com' on two
-- rows after lowercasing 'Acme.com' + 'acme.com'), the next CREATE UNIQUE
-- INDEX will fail and the transaction rolls back. Operator must dedupe per
-- docs/superpowers/plans/2026-05-06-anthropic-gtm-revamp.md Task 1.1.5.
CREATE UNIQUE INDEX `accounts_domain_unique` ON `accounts` (lower("domain")) WHERE domain IS NOT NULL AND domain <> '';--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_email_unique` ON `contacts` (lower("email")) WHERE email IS NOT NULL AND email <> '';--> statement-breakpoint
-- Preflight: 0003 allowed routing_assignments.score_id IS NULL. 0004 makes
-- it NOT NULL. Drop any null-score rows first; they were never reachable from
-- v2 routing logic anyway (route() always has a scoreId).
DELETE FROM `routing_assignments` WHERE `score_id` IS NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_routing_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`owner_email` text NOT NULL,
	`reason` text NOT NULL,
	`matched_rule_key` text,
	`routing_rules_hash` text NOT NULL,
	`score_id` text NOT NULL,
	`assigned_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`score_id`) REFERENCES `lead_scores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_routing_assignments`("id", "account_id", "owner_email", "reason", "matched_rule_key", "routing_rules_hash", "score_id", "assigned_at") SELECT "id", "account_id", "owner_email", "reason", "matched_rule_key", "routing_rules_hash", "score_id", "assigned_at" FROM `routing_assignments`;--> statement-breakpoint
DROP TABLE `routing_assignments`;--> statement-breakpoint
ALTER TABLE `__new_routing_assignments` RENAME TO `routing_assignments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `routing_assignments_account_score_rules_unique` ON `routing_assignments` (`account_id`,`score_id`,`routing_rules_hash`);
