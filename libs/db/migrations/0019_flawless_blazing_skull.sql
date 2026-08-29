-- Multiple caretakers per task: ownership moves from `tasks.owner_member_id`
-- to a `task_owners` set, so an attendance task can be covered by more than one
-- caretaker at a time.
CREATE TABLE `task_owners` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`family_member_id` text NOT NULL,
	`auto_assigned_rule_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_owners_task_member_uq` ON `task_owners` (`task_id`,`family_member_id`);--> statement-breakpoint
CREATE INDEX `task_owners_member_idx` ON `task_owners` (`family_member_id`);--> statement-breakpoint
-- Carry every existing claim over as a single-owner set, rule stamp and all.
INSERT INTO `task_owners` (`id`, `task_id`, `family_member_id`, `auto_assigned_rule_id`, `created_at`)
SELECT lower(
		hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-'
		|| substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
	),
	`id`, `owner_member_id`, `auto_assigned_rule_id`, `created_at`
FROM `tasks` WHERE `owner_member_id` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `auto_assigned_rule_id`;--> statement-breakpoint
-- `owner_member_id` is emptied rather than dropped, and is gone from the Drizzle
-- schema either way. SQLite refuses DROP COLUMN on a column named in a table
-- FOREIGN KEY clause, and the rebuild Drizzle would generate instead is not safe
-- on D1: DROP TABLE fires ON DELETE CASCADE (PRAGMA foreign_keys is a no-op
-- inside the implicit transaction a migration runs in, and defer_foreign_keys
-- only defers violation checks, not actions), which would delete every claimed
-- calendar event and its travel-time override along with the old table.
UPDATE `tasks` SET `owner_member_id` = NULL;
