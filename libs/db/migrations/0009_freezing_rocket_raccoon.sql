ALTER TABLE `tasks` ADD `location_geo` text;--> statement-breakpoint
-- Backfill from the event each task was generated from: tasks predating this
-- column already carry the event's location text, just not its geocode. Without
-- this, an existing pickup/drop-off would only pick the geocode up if its event
-- happened to change (task-gen heals dirty events only), so claimed tasks would
-- stay travel-time-less indefinitely. The claimed calendar_events themselves are
-- healed by the next `reconcileClaimEvents` tick, which re-hashes the payload.
UPDATE `tasks` SET `location_geo` = (
  SELECT `location_geo` FROM `calendar_events`
  WHERE `calendar_events`.`id` = `tasks`.`calendar_event_id`
)
WHERE `calendar_event_id` IS NOT NULL;
