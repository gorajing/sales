CREATE TABLE `deliverable_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`deliverable_id` text NOT NULL,
	`account_id` text NOT NULL,
	`rank` integer NOT NULL,
	`why_now_md` text,
	`deal_shape` text,
	`routing` text,
	`time_ask` text,
	`trigger_summary` text,
	`sequence_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`deliverable_id`) REFERENCES `deliverables`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `deliverables` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`intro_md` text,
	`outro_md` text,
	`raw_md` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
