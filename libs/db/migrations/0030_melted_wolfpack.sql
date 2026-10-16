ALTER TABLE `event_mirrors` ADD `failure_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `event_mirrors` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `event_mirrors` ADD `failed_payload_hash` text;--> statement-breakpoint
ALTER TABLE `member_calendars` ADD `read_back_attempted_at` integer;--> statement-breakpoint
ALTER TABLE `member_calendars` ADD `read_back_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `member_calendars` ADD `last_read_back_error` text;--> statement-breakpoint
ALTER TABLE `member_calendars` ADD `mirror_attempted_at` integer;--> statement-breakpoint
ALTER TABLE `member_calendars` ADD `mirror_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `member_calendars` ADD `last_mirror_error` text;