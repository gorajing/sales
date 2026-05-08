DROP INDEX `accounts_domain_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_domain_unique` ON `accounts` (lower("domain")) WHERE domain IS NOT NULL AND domain <> '';--> statement-breakpoint
DROP INDEX `contacts_email_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_email_unique` ON `contacts` (lower("email")) WHERE email IS NOT NULL AND email <> '';--> statement-breakpoint
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