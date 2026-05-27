CREATE TABLE `gtm_handoff_imports` (
	`router_deal_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`schema_version` text NOT NULL,
	`generated_at` text NOT NULL,
	`imported_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`account_name` text NOT NULL,
	`account_domain` text,
	`route_kind` text NOT NULL,
	`sales_owner` text,
	`amount_usd` integer NOT NULL,
	`source_channel` text NOT NULL,
	`research_brief` text NOT NULL,
	`suggested_evidence_questions_json` text DEFAULT '[]' NOT NULL,
	`payload_json` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
