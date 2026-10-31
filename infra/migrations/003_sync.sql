-- Selected-chat recovery scans. Run as the migration owner.
BEGIN;
CREATE TABLE sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_chat_id uuid NOT NULL,
  account_key text NOT NULL CHECK(account_key ~ '^[A-Za-z0-9_-]{3,80}$'),
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','WAITING_PROVIDER','WAITING_NETWORK','COMPLETED','FAILED','CANCELLED')),
  history_cursor text,
  scanned_files bigint NOT NULL DEFAULT 0 CHECK(scanned_files>=0),
  imported_files bigint NOT NULL DEFAULT 0 CHECK(imported_files>=0),
  skipped_files bigint NOT NULL DEFAULT 0 CHECK(skipped_files>=0),
  pages integer NOT NULL DEFAULT 0 CHECK(pages>=0),
  failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count>=0),
  retry_after timestamptz,
  error_code text,
  lease_owner uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(user_id,id),
  FOREIGN KEY(user_id,storage_chat_id) REFERENCES storage_chats(user_id,id),
  CHECK((lease_owner IS NULL)=(lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX one_active_sync_per_chat ON sync_jobs(user_id,storage_chat_id)
  WHERE state IN ('QUEUED','RUNNING','WAITING_PROVIDER','WAITING_NETWORK');
CREATE INDEX sync_jobs_runnable ON sync_jobs(updated_at,id)
  WHERE state IN ('QUEUED','RUNNING','WAITING_PROVIDER','WAITING_NETWORK');
ALTER TABLE sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_jobs USING(user_id=cloudnest_current_user()) WITH CHECK(user_id=cloudnest_current_user());

-- Only opaque runnable identifiers are enumerated; runtime roles never need BYPASSRLS.
CREATE FUNCTION cloudnest_runnable_sync_jobs(requested_limit integer DEFAULT 20)
RETURNS TABLE(user_id uuid,job_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT j.user_id,j.id FROM public.sync_jobs j JOIN public.users u ON u.id=j.user_id
  WHERE u.status='active' AND j.state IN ('QUEUED','RUNNING','WAITING_PROVIDER','WAITING_NETWORK')
    AND (j.retry_after IS NULL OR j.retry_after<=now())
    AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=now())
  ORDER BY j.updated_at,j.id LIMIT greatest(1,least(coalesce(requested_limit,20),100))
$$;
REVOKE ALL ON FUNCTION cloudnest_runnable_sync_jobs(integer) FROM PUBLIC;
COMMIT;
