CREATE TABLE `assignment_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`owner_member_id` text NOT NULL,
	`about_member_id` text,
	`link_id` text,
	`task_type` text,
	`position` integer NOT NULL,
	`weekday_mask` integer DEFAULT 0 NOT NULL,
	`cadence_weeks` integer DEFAULT 1 NOT NULL,
	`anchor_date` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`about_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`link_id`) REFERENCES `family_member_feeds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `assignment_rules_family_position_idx` ON `assignment_rules` (`family_id`,`position`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `auto_assigned_rule_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `manual_owner_override` integer DEFAULT false NOT NULL;