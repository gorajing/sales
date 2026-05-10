DROP INDEX `lead_scores_account_fingerprint_unique`;--> statement-breakpoint
CREATE INDEX `lead_scores_account_fingerprint_idx` ON `lead_scores` (`account_id`,`fingerprint`);