CREATE TABLE `conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`family_member_id` text NOT NULL,
	`loser_key` text NOT NULL,
	`winner_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolved_by_member_id` text,
	`resolved_at` integer,
	`dismissed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_by_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conflicts_member_pair_uq` ON `conflicts` (`family_member_id`,`loser_key`,`winner_key`);--> statement-breakpoint
CREATE INDEX `conflicts_family_status_idx` ON `conflicts` (`family_id`,`status`);--> statement-breakpoint
CREATE INDEX `conflicts_member_idx` ON `conflicts` (`family_member_id`);