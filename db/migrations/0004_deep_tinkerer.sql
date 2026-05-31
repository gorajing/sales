CREATE TABLE `engagement_events` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`router_deal_id` text NOT NULL,
	`touch_id` text,
	`kind` text NOT NULL,
	`event_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`source` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`touch_id`) REFERENCES `touches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `engagement_events_router_deal_kind_event_idx` ON `engagement_events` (`router_deal_id`,`kind`,`event_id`);