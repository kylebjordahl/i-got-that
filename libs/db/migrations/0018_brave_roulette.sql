ALTER TABLE `feeds` ADD `last_attempted_at` integer;--> statement-breakpoint
ALTER TABLE `feeds` ADD `consecutive_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `feeds` ADD `last_error_message` text;