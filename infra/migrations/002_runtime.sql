-- Runtime additions. Apply as the migration owner, never the HTTP runtime role.
BEGIN;

ALTER TABLE devices ADD COLUMN label text NOT NULL DEFAULT 'Web browser';
ALTER TABLE product_sessions ADD COLUMN hashed_csrf_token text NOT NULL DEFAULT '';
ALTER TABLE telegram_sessions ADD COLUMN account_key text;
CREATE UNIQUE INDEX telegram_account_keys ON telegram_sessions(account_key) WHERE account_key IS NOT NULL;
ALTER TABLE files ADD COLUMN local_blob_id text;
ALTER TABLE files ADD COLUMN remote_reference jsonb;
ALTER TABLE transfers ADD COLUMN folder_id uuid;
ALTER TABLE transfers ADD COLUMN name text NOT NULL DEFAULT 'File';
ALTER TABLE transfers ADD COLUMN mime text NOT NULL DEFAULT 'application/octet-stream';
ALTER TABLE transfers ADD COLUMN sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$');
ALTER TABLE transfers ADD CONSTRAINT transfers_folder_tenant FOREIGN KEY(user_id,folder_id) REFERENCES folders(user_id,id);
ALTER TABLE catalog_tombstones ADD COLUMN file_id uuid;
ALTER TABLE catalog_tombstones ADD COLUMN remote_reference jsonb;
CREATE INDEX catalog_tombstones_file ON catalog_tombstones(user_id,file_id);

CREATE TABLE session_refresh_history (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,session_id,token_hash),
  FOREIGN KEY(user_id,session_id) REFERENCES product_sessions(user_id,id) ON DELETE CASCADE
);
ALTER TABLE session_refresh_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_refresh_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON session_refresh_history USING(user_id=cloudnest_current_user()) WITH CHECK(user_id=cloudnest_current_user());

CREATE TABLE login_transactions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  account_key text NOT NULL UNIQUE,
  state jsonb NOT NULL DEFAULT '{"state":"connecting"}',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_transactions_expiry ON login_transactions(expires_at);
ALTER TABLE login_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY login_transaction_scope ON login_transactions
  USING(id=nullif(current_setting('cloudnest.login_id',true),'')::uuid)
  WITH CHECK(id=nullif(current_setting('cloudnest.login_id',true),'')::uuid);

CREATE TABLE auth_rate_limits (
  key_hash text PRIMARY KEY CHECK(key_hash ~ '^[a-f0-9]{64}$'),
  used integer NOT NULL,
  window_ends timestamptz NOT NULL
);
ALTER TABLE auth_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_rate_limits FORCE ROW LEVEL SECURITY;
-- No direct runtime policy: rate counters are available only through the bounded function.

-- These narrowly scoped functions run as the migration owner, which must be able
-- to bypass forced RLS. Runtime roles never receive BYPASSRLS or table ownership.
-- Call verified-user upsert only after an authenticated Telegram adapter getMe.
CREATE FUNCTION cloudnest_upsert_verified_user(provider_id bigint, requested_locale text)
RETURNS TABLE(id uuid,telegram_user_id bigint,locale text,status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  IF provider_id<=0 OR requested_locale NOT IN ('en','bn') THEN RAISE EXCEPTION 'Invalid verified identity' USING ERRCODE='22023'; END IF;
  RETURN QUERY INSERT INTO public.users AS u(telegram_user_id,locale)
    VALUES(provider_id,requested_locale)
    ON CONFLICT ON CONSTRAINT users_telegram_user_id_key DO UPDATE SET telegram_user_id=EXCLUDED.telegram_user_id
    RETURNING u.id,u.telegram_user_id,u.locale,u.status;
END
$$;

CREATE FUNCTION cloudnest_connected_accounts()
RETURNS TABLE(user_id uuid,account_key text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT s.user_id,s.account_key FROM public.telegram_sessions s JOIN public.users u ON u.id=s.user_id
    WHERE s.runtime_kind='server' AND s.state='connected' AND s.account_key IS NOT NULL AND u.status='active'
$$;

CREATE FUNCTION cloudnest_check_rate_limit(counter_key text,request_limit integer,window_seconds integer)
RETURNS TABLE(allowed boolean,retry_after_seconds integer,remaining integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE result_used integer; result_end timestamptz;
BEGIN
  IF counter_key !~ '^[a-f0-9]{64}$' OR request_limit<1 OR request_limit>10000 OR window_seconds<1 OR window_seconds>86400 THEN
    RAISE EXCEPTION 'Invalid rate policy' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.auth_rate_limits AS r(key_hash,used,window_ends)
    VALUES(counter_key,1,now()+make_interval(secs=>window_seconds))
    ON CONFLICT(key_hash) DO UPDATE SET
      used=CASE WHEN r.window_ends<=now() THEN 1 ELSE least(r.used+1,1000000000) END,
      window_ends=CASE WHEN r.window_ends<=now() THEN now()+make_interval(secs=>window_seconds) ELSE r.window_ends END
    RETURNING used,window_ends INTO result_used,result_end;
  RETURN QUERY SELECT result_used<=request_limit,
    CASE WHEN result_used>request_limit THEN greatest(1,ceil(extract(epoch FROM result_end-now()))::integer) ELSE 0 END,
    greatest(0,request_limit-result_used);
END
$$;

REVOKE ALL ON FUNCTION cloudnest_upsert_verified_user(bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION cloudnest_connected_accounts() FROM PUBLIC;
REVOKE ALL ON FUNCTION cloudnest_check_rate_limit(text,integer,integer) FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

COMMIT;
