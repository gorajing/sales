CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`domain` text,
	`industry` text,
	`size` text,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `call_prep_briefs` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`openers_json` text DEFAULT '[]' NOT NULL,
	`discovery_questions_json` text DEFAULT '[]' NOT NULL,
	`objections_json` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`full_name` text NOT NULL,
	`title` text,
	`linkedin_url` text,
	`email` text,
	`archetype` text DEFAULT 'unknown' NOT NULL,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `critiques` (
	`id` text PRIMARY KEY NOT NULL,
	`touch_revision_id` text NOT NULL,
	`critic_name` text NOT NULL,
	`verdict` text NOT NULL,
	`findings_json` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`touch_revision_id`) REFERENCES `touch_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`contact_id` text,
	`source_url` text NOT NULL,
	`source_type` text NOT NULL,
	`snippet` text NOT NULL,
	`extracted_fact` text NOT NULL,
	`extraction_status` text DEFAULT 'pending_audit' NOT NULL,
	`confidence` text DEFAULT 'medium' NOT NULL,
	`captured_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`captured_by` text NOT NULL,
	`superseded_by` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `extraction_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`evidence_id` text NOT NULL,
	`verdict` text NOT NULL,
	`reason` text NOT NULL,
	`suggested_correction` text,
	`resolved_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidence`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sequences` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `touch_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`touch_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`subject` text,
	`body` text NOT NULL,
	`cited_evidence_ids` text DEFAULT '[]' NOT NULL,
	`supporting_spans` text DEFAULT '[]' NOT NULL,
	`rationale` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`touch_id`) REFERENCES `touches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `touches` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence_id` text NOT NULL,
	`position` integer NOT NULL,
	`channel` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_revision_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`sent_at` text,
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE no action
);
