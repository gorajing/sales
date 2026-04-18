PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_evidence` (
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
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_by`) REFERENCES `evidence`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_evidence`("id", "account_id", "contact_id", "source_url", "source_type", "snippet", "extracted_fact", "extraction_status", "confidence", "captured_at", "captured_by", "superseded_by") SELECT "id", "account_id", "contact_id", "source_url", "source_type", "snippet", "extracted_fact", "extraction_status", "confidence", "captured_at", "captured_by", "superseded_by" FROM `evidence`;--> statement-breakpoint
DROP TABLE `evidence`;--> statement-breakpoint
ALTER TABLE `__new_evidence` RENAME TO `evidence`;--> statement-breakpoint
PRAGMA foreign_keys=ON;