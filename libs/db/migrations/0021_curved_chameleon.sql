CREATE TABLE `email_output_mirrors` (
	`id` text PRIMARY KEY NOT NULL,
	`email_output_id` text NOT NULL,
	`calendar_event_id` text NOT NULL,
	`ical_uid` text NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`payload_hash` text,
	`summary` text NOT NULL,
	`event_starts_at` integer NOT NULL,
	`event_ends_at` integer NOT NULL,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`email_output_id`) REFERENCES `email_outputs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_output_mirrors_output_event_uq` ON `email_output_mirrors` (`email_output_id`,`calendar_event_id`);--> statement-breakpoint
CREATE TABLE `email_outputs` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`family_member_id` text NOT NULL,
	`created_by_user_id` text,
	`email` text NOT NULL,
	`label` text,
	`filters` text NOT NULL,
	`alert_minutes` text,
	`active` integer DEFAULT true NOT NULL,
	`verified_at` integer,
	`last_mirrored_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_outputs_member_email_uq` ON `email_outputs` (`family_member_id`,`email`);--> statement-breakpoint
CREATE INDEX `email_outputs_family_idx` ON `email_outputs` (`family_id`);--> statement-breakpoint
CREATE TABLE `email_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email_output_id` text NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_verifications_token_hash_unique` ON `email_verifications` (`token_hash`);--> statement-breakpoint
CREATE INDEX `email_verifications_user_created_idx` ON `email_verifications` (`user_id`,`created_at`);