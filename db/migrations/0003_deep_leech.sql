CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`trigger` text NOT NULL,
	`severity` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`channels_sent_json` text DEFAULT '[]' NOT NULL,
	`cooldown_key` text,
	`acknowledged_at` text,
	`acknowledged_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_cooldown_key_unique` ON `alerts` (`cooldown_key`);--> statement-breakpoint
CREATE TABLE `lead_scores` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`contact_id` text,
	`score` integer NOT NULL,
	`tier` text NOT NULL,
	`rationale_json` text DEFAULT '[]' NOT NULL,
	`fingerprint` text NOT NULL,
	`computed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lead_scores_account_fingerprint_unique` ON `lead_scores` (`account_id`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `routing_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`owner_email` text NOT NULL,
	`reason` text NOT NULL,
	`matched_rule_key` text,
	`routing_rules_hash` text NOT NULL,
	`score_id` text,
	`assigned_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`score_id`) REFERENCES `lead_scores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `routing_assignments_account_score_rules_unique` ON `routing_assignments` (`account_id`,`score_id`,`routing_rules_hash`);--> statement-breakpoint
ALTER TABLE `evidence` ADD `signal_type` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `evidence` ADD `dedupe_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_dedupe_key_unique` ON `evidence` (`dedupe_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_domain_unique` ON `accounts` (`domain`) WHERE domain IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_email_unique` ON `contacts` (`email`) WHERE email IS NOT NULL;