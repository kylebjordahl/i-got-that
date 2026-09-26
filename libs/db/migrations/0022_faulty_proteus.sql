ALTER TABLE `email_output_mirrors` ADD `timezone` text;--> statement-breakpoint
ALTER TABLE `email_outputs` ADD `pad_travel_time` integer DEFAULT false NOT NULL;