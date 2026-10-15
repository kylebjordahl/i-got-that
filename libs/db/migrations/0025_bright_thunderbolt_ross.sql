CREATE TABLE `absence_notice_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`link_id` text NOT NULL,
	`to_addresses` text NOT NULL,
	`cc_addresses` text NOT NULL,
	`subject_template` text NOT NULL,
	`body_template` text NOT NULL,
	`include_reason` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`link_id`) REFERENCES `family_member_feeds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `absence_notice_settings_link_uq` ON `absence_notice_settings` (`link_id`);--> statement-breakpoint
CREATE INDEX `absence_notice_settings_family_idx` ON `absence_notice_settings` (`family_id`);--> statement-breakpoint
CREATE TABLE `absence_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`family_member_id` text NOT NULL,
	`link_id` text NOT NULL,
	`date` text NOT NULL,
	`sent_by_member_id` text,
	`sent_at` integer NOT NULL,
	`gap_stamp` text NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`link_id`) REFERENCES `family_member_feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sent_by_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `absence_notices_key_uq` ON `absence_notices` (`family_member_id`,`link_id`,`date`);--> statement-breakpoint
CREATE INDEX `absence_notices_family_date_idx` ON `absence_notices` (`family_id`,`date`);