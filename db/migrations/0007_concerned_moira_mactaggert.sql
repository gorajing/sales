CREATE TABLE `connector_poll_state` (
	`connector_name` text PRIMARY KEY NOT NULL,
	`last_polled_at` text NOT NULL
);
