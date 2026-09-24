CREATE TABLE `link_baseline_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`link_id` text NOT NULL,
	`effective_from` text NOT NULL,
	`day_start` text NOT NULL,
	`day_end` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`link_id`) REFERENCES `family_member_feeds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `link_baseline_changes_link_date_uq` ON `link_baseline_changes` (`link_id`,`effective_from`);--> statement-breakpoint
CREATE INDEX `link_baseline_changes_family_idx` ON `link_baseline_changes` (`family_id`);