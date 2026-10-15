-- Existing digest schedules should include the new `absence_notices` category
-- (new schedules default it on in the app), so the badge and digests count
-- absence emails still to send without anyone having to opt in.
UPDATE `notification_schedules`
SET `categories` = json_insert(`categories`, '$[#]', 'absence_notices')
WHERE NOT EXISTS (
  SELECT 1 FROM json_each(`notification_schedules`.`categories`) WHERE `value` = 'absence_notices'
);
