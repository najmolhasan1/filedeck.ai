-- Keep an upload bound to the TDLib account database that staged its bytes.
BEGIN;
ALTER TABLE transfers ADD COLUMN account_key text;
CREATE INDEX transfers_staging_account ON transfers(user_id,account_key) WHERE account_key IS NOT NULL;
COMMIT;
