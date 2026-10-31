-- Canonical proposed PostgreSQL schema. The current local-demo API uses a
-- separate JSON repository: this migration is not yet a production repository.
-- Run as migration owner; use a separate NOSUPERUSER NOBYPASSRLS runtime role.
BEGIN;

CREATE FUNCTION cloudnest_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('cloudnest.user_id', true), '')::uuid
$$;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id bigint UNIQUE,
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'bn')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deletion_pending')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('web', 'android', 'ios', 'desktop')),
  last_seen timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (user_id, id)
);

CREATE TABLE product_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  hashed_refresh_token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, id),
  UNIQUE (user_id, id)
);

CREATE TABLE telegram_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  runtime_kind text NOT NULL CHECK (runtime_kind IN ('server', 'android', 'ios')),
  encrypted_state_ref text NOT NULL,
  kms_key_version text NOT NULL,
  state text NOT NULL DEFAULT 'disconnected',
  lease_owner uuid,
  lease_expiry timestamptz,
  UNIQUE (user_id, id),
  CHECK ((lease_owner IS NULL) = (lease_expiry IS NULL))
);
CREATE UNIQUE INDEX one_server_session_per_user ON telegram_sessions(user_id)
  WHERE runtime_kind = 'server';

CREATE TABLE storage_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remote_peer_id bigint NOT NULL,
  type text NOT NULL CHECK (type IN ('saved_messages', 'private_channel', 'private_chat')),
  verified_permissions jsonb NOT NULL DEFAULT '{}',
  selected_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'available', 'unavailable', 'revoked')),
  UNIQUE (user_id, id),
  UNIQUE (user_id, remote_peer_id)
);

CREATE TABLE folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id uuid,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 255),
  color text NOT NULL DEFAULT 'mint',
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  trashed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, parent_id) REFERENCES folders(user_id, id),
  CHECK (id IS DISTINCT FROM parent_id)
);
CREATE UNIQUE INDEX folder_active_names ON folders
  (user_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  WHERE trashed_at IS NULL;

-- Serialize hierarchy mutations per tenant so concurrent opposing moves cannot
-- each pass a cycle check. Count both ancestors and moved descendants.
CREATE FUNCTION enforce_folder_tree() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ancestor_count integer; descendant_depth integer; has_cycle boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 0));
  IF TG_OP = 'UPDATE' AND NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'Folder ownership cannot change' USING ERRCODE = '23514';
  END IF;
  WITH RECURSIVE ancestors AS (
    SELECT id, parent_id, 1 AS depth FROM folders
      WHERE user_id = NEW.user_id AND id = NEW.parent_id
    UNION ALL
    SELECT f.id, f.parent_id, a.depth + 1 FROM folders f JOIN ancestors a ON f.id = a.parent_id
      WHERE f.user_id = NEW.user_id AND a.depth <= 10
  ) SELECT coalesce(max(depth), 0), coalesce(bool_or(id = NEW.id), false)
      INTO ancestor_count, has_cycle FROM ancestors;
  IF has_cycle THEN RAISE EXCEPTION 'Folder cycle' USING ERRCODE = '23514'; END IF;
  WITH RECURSIVE descendants AS (
    SELECT id, 1 AS depth FROM folders WHERE user_id = NEW.user_id AND id = NEW.id
    UNION ALL
    SELECT f.id, d.depth + 1 FROM folders f JOIN descendants d ON f.parent_id = d.id
      WHERE f.user_id = NEW.user_id AND d.depth <= 10
  ) SELECT coalesce(max(depth), 1) INTO descendant_depth FROM descendants;
  IF ancestor_count + descendant_depth > 10 THEN
    RAISE EXCEPTION 'Folder depth exceeds 10' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER folders_tree BEFORE INSERT OR UPDATE OF parent_id, user_id
  ON folders FOR EACH ROW EXECUTE FUNCTION enforce_folder_tree();

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id uuid,
  storage_chat_id uuid,
  remote_message_id bigint,
  attachment_index integer NOT NULL DEFAULT 0 CHECK (attachment_index >= 0),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 255),
  original_name text NOT NULL,
  mime text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes >= 0),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  origin text NOT NULL CHECK (origin IN ('web', 'android', 'ios', 'recovered', 'demo')),
  availability text NOT NULL DEFAULT 'pending' CHECK (availability IN ('pending', 'confirmed', 'device_reported', 'unavailable', 'missing', 'local_only')),
  favorite boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  trashed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, folder_id) REFERENCES folders(user_id, id),
  FOREIGN KEY (user_id, storage_chat_id) REFERENCES storage_chats(user_id, id),
  CHECK (availability <> 'confirmed' OR (storage_chat_id IS NOT NULL AND remote_message_id IS NOT NULL)),
  UNIQUE (user_id, storage_chat_id, remote_message_id, attachment_index)
);
CREATE INDEX files_cursor ON files(user_id, created_at DESC, id DESC) WHERE trashed_at IS NULL;
CREATE INDEX files_folder ON files(user_id, folder_id, created_at DESC, id DESC) WHERE trashed_at IS NULL;
CREATE INDEX files_mime ON files(user_id, mime) WHERE trashed_at IS NULL;
CREATE INDEX files_favorite ON files(user_id, favorite) WHERE trashed_at IS NULL AND favorite;
CREATE INDEX files_name ON files(user_id, lower(display_name));

CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 64),
  UNIQUE (user_id, id),
  UNIQUE (user_id, name)
);
CREATE TABLE file_tags (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  PRIMARY KEY (user_id, file_id, tag_id),
  FOREIGN KEY (user_id, file_id) REFERENCES files(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, tag_id) REFERENCES tags(user_id, id) ON DELETE CASCADE
);

CREATE TABLE transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid,
  file_id uuid,
  operation_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'CREATED' CHECK (state IN ('CREATED','STAGING','STAGED','QUEUED','SENDING','VERIFYING','COMPLETED','WAITING_PROVIDER','WAITING_NETWORK','CANCEL_REQUESTED','CANCELLED','RETRY_SCHEDULED','RECONCILING','NEEDS_ATTENTION','FAILED')),
  expected_bytes bigint NOT NULL CHECK (expected_bytes >= 0),
  stage_bytes bigint NOT NULL DEFAULT 0 CHECK (stage_bytes >= 0),
  provider_bytes bigint NOT NULL DEFAULT 0 CHECK (provider_bytes >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_after timestamptz,
  error_code text,
  remote_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  UNIQUE (user_id, operation_id),
  FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, id),
  FOREIGN KEY (user_id, file_id) REFERENCES files(user_id, id),
  CHECK (stage_bytes <= expected_bytes AND provider_bytes <= expected_bytes),
  CHECK (state <> 'COMPLETED' OR remote_result IS NOT NULL)
);
CREATE INDEX transfers_pending ON transfers(user_id, state, updated_at)
  WHERE state NOT IN ('COMPLETED', 'CANCELLED');

CREATE TABLE uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transfer_id uuid NOT NULL,
  staging_ref text NOT NULL,
  expected_bytes bigint NOT NULL CHECK (expected_bytes BETWEEN 0 AND 524288000),
  offset_bytes bigint NOT NULL DEFAULT 0 CHECK (offset_bytes >= 0),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, transfer_id) REFERENCES transfers(user_id, id),
  CHECK (offset_bytes <= expected_bytes)
);
CREATE TABLE upload_chunks (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_id uuid NOT NULL,
  offset_bytes bigint NOT NULL CHECK (offset_bytes >= 0),
  length_bytes integer NOT NULL CHECK (length_bytes > 0),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('verified', 'invalid')),
  PRIMARY KEY (user_id, upload_id, offset_bytes),
  FOREIGN KEY (user_id, upload_id) REFERENCES uploads(user_id, id) ON DELETE CASCADE
);

CREATE TABLE backup_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  local_source_identifier text NOT NULL,
  policy jsonb NOT NULL DEFAULT '{"wifi_only":true,"include_existing":false}',
  permission_state text NOT NULL,
  cursor text,
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, id)
);
CREATE TABLE backup_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  stable_asset_id text NOT NULL,
  content_version text NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  hash text,
  state text NOT NULL,
  transfer_id uuid,
  file_id uuid,
  UNIQUE (user_id, id),
  UNIQUE (user_id, source_id, stable_asset_id, content_version),
  FOREIGN KEY (user_id, source_id) REFERENCES backup_sources(user_id, id),
  FOREIGN KEY (user_id, transfer_id) REFERENCES transfers(user_id, id),
  FOREIGN KEY (user_id, file_id) REFERENCES files(user_id, id)
);

CREATE TABLE sync_checkpoints (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_chat_id uuid NOT NULL,
  history_cursor text,
  update_cursor text,
  last_reconciled_at timestamptz,
  PRIMARY KEY (user_id, storage_chat_id),
  FOREIGN KEY (user_id, storage_chat_id) REFERENCES storage_chats(user_id, id)
);
CREATE TABLE catalog_tombstones (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remote_attachment_key text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, remote_attachment_key)
);
CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_scope text NOT NULL,
  key text NOT NULL,
  request_digest text NOT NULL,
  response_ref jsonb NOT NULL,
  expiry timestamptz NOT NULL,
  PRIMARY KEY (user_id, route_scope, key)
);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload_ref jsonb NOT NULL,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_undelivered ON outbox_events(created_at, id) WHERE delivered_at IS NULL;
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action text NOT NULL,
  opaque_resource_id uuid,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY user_self ON users USING (id = cloudnest_current_user())
  WITH CHECK (id = cloudnest_current_user());
DO $$
DECLARE tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'devices','product_sessions','telegram_sessions','storage_chats','folders',
    'files','tags','file_tags','transfers','uploads','upload_chunks','backup_sources',
    'backup_items','sync_checkpoints','catalog_tombstones','idempotency_keys',
    'outbox_events','audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (user_id = cloudnest_current_user()) WITH CHECK (user_id = cloudnest_current_user())', tenant_table);
  END LOOP;
END
$$;

COMMIT;
