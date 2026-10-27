CREATE TABLE `task_rule_exceptions` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`calendar_event_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rule_id`) REFERENCES `task_rules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`calendar_event_id`) REFERENCES `calendar_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_rule_exceptions_rule_event_uq` ON `task_rule_exceptions` (`rule_id`,`calendar_event_id`);--> statement-breakpoint
CREATE INDEX `task_rule_exceptions_event_idx` ON `task_rule_exceptions` (`calendar_event_id`);