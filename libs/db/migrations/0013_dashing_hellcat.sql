ALTER TABLE `calendar_events` ADD `travel_time_override_min` integer;--> statement-breakpoint
ALTER TABLE `family_members` ADD `home_location` text;--> statement-breakpoint
ALTER TABLE `family_members` ADD `home_location_geo` text;--> statement-breakpoint
ALTER TABLE `source_events` ADD `location_geo` text;