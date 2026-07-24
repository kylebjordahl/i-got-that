ALTER TABLE `conflicts` ADD `travel_before_min` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `conflicts` ADD `travel_after_min` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `conflicts` ADD `before_needed` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `conflicts` ADD `after_needed` integer DEFAULT true NOT NULL;