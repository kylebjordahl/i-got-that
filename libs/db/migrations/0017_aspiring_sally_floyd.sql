CREATE TABLE `notification_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text DEFAULT 'Daily brief' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`send_at` text NOT NULL,
	`timezone` text NOT NULL,
	`weekday_mask` integer DEFAULT 127 NOT NULL,
	`start_offset_days` integer DEFAULT 1 NOT NULL,
	`horizon_days` integer DEFAULT 1 NOT NULL,
	`categories` text NOT NULL,
	`skip_when_empty` integer DEFAULT true NOT NULL,
	`last_sent_slot` text,
	`last_sent_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_schedules_user_idx` ON `notification_schedules` (`user_id`);--> statement-breakpoint
CREATE INDEX `notification_schedules_enabled_idx` ON `notification_schedules` (`enabled`);--> statement-breakpoint
CREATE TABLE `push_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_token` text NOT NULL,
	`bundle_id` text NOT NULL,
	`environment` text NOT NULL,
	`platform` text DEFAULT 'ios' NOT NULL,
	`timezone` text,
	`last_seen_at` integer,
	`disabled_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_devices_token_uq` ON `push_devices` (`device_token`);--> statement-breakpoint
CREATE INDEX `push_devices_user_idx` ON `push_devices` (`user_id`);--> statement-breakpoint
CREATE INDEX `tasks_family_start_idx` ON `tasks` (`family_id`,`dtstart`);