CREATE TABLE `engagement_events` (
	`id` text PRIMARY KEY NOT NULL,
	`touch_id` text,
	`contact_id` text,
	`event_type` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`occurred_at` text NOT NULL,
	`external_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`touch_id`) REFERENCES `touches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `engagement_events_external_id_unique` ON `engagement_events` (`external_id`);