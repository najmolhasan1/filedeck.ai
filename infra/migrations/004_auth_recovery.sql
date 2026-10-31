-- Durable provider revocation and verified canonical worker reuse.
BEGIN;
ALTER TABLE login_transactions ADD COLUMN completed_user_id uuid REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX login_transactions_completed_user ON login_transactions(completed_user_id,account_key) WHERE completed_user_id IS NOT NULL;
CREATE POLICY completed_login_owner ON login_transactions USING(completed_user_id=cloudnest_current_user()) WITH CHECK(completed_user_id=cloudnest_current_user());
CREATE TABLE pending_revocations (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 account_key text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','confirmed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 retry_after timestamptz NOT NULL DEFAULT now(),
 last_error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,account_key)
);
CREATE INDEX pending_revocations_ready ON pending_revocations(retry_after) WHERE state='pending';
ALTER TABLE pending_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_revocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pending_revocations USING(user_id=cloudnest_current_user()) WITH CHECK(user_id=cloudnest_current_user());
CREATE FUNCTION cloudnest_pending_revocations(batch_limit integer)
RETURNS TABLE(user_id uuid,account_key text,attempts integer)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
 SELECT p.user_id,p.account_key,p.attempts FROM public.pending_revocations p
 WHERE p.state='pending' AND p.retry_after<=now()
 ORDER BY p.retry_after,p.user_id,p.account_key LIMIT greatest(1,least(batch_limit,100))
$$;
REVOKE ALL ON FUNCTION cloudnest_pending_revocations(integer) FROM PUBLIC;
COMMIT;
