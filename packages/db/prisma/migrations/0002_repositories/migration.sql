-- Columns the repository layer needs (generated with `prisma migrate diff` from 0001), plus hand-written CHECKs.
-- Closed value sets mirror @bastion-mcp/core constants; schema-conformance.test.ts keeps them in sync.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "scim_external_id" TEXT;

-- AlterTable
ALTER TABLE "role_mapping_rules" ADD COLUMN     "updated_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "service_accounts" ADD COLUMN     "auth_method" TEXT NOT NULL DEFAULT 'client_secret_basic',
ADD COLUMN     "jwks" JSONB,
ADD COLUMN     "secret_sha256" TEXT,
ADD COLUMN     "updated_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "catalog_versions" ADD COLUMN     "runtime" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "upstream_snapshots" ADD COLUMN     "ttl_ms" INTEGER;

-- AlterTable
ALTER TABLE "guard_profiles" ADD COLUMN     "settings" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "failures" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "remote_session" JSONB,
ADD COLUMN     "running_version_id" UUID,
ADD COLUMN     "user_id" UUID;

-- AlterTable
ALTER TABLE "auto_install_policies" ADD COLUMN     "updated_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "registry_sources" ADD COLUMN     "auth_header_name" TEXT,
ADD COLUMN     "updated_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "registry_servers" ADD COLUMN     "meta" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "call_stats_minute" ADD COLUMN     "error_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "egress_events" ADD COLUMN     "protocol" TEXT,
ADD COLUMN     "reason" TEXT;

-- AlterTable
ALTER TABLE "call_stats_hour" ADD COLUMN     "error_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "call_stats_day" ADD COLUMN     "error_count" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "users_idp_connection_id_scim_external_id_key" ON "users"("idp_connection_id", "scim_external_id");


-- CHECK constraints ------------------------------------------------------------------------------
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_status_check" CHECK (status in ('active','disabled'));
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_auth_method_check" CHECK (auth_method in ('client_secret_basic','private_key_jwt'));
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_principal_type_check" CHECK (principal_type in ('user','service'));
ALTER TABLE "upstream_tokens" ADD CONSTRAINT "upstream_tokens_principal_type_check" CHECK (principal_type in ('user','service'));
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_prefix_mode_check" CHECK (prefix_mode in ('always','onCollision'));
ALTER TABLE "upstream_clients" ADD CONSTRAINT "upstream_clients_registration_check" CHECK (registration in ('preRegistered','cimd','dcr'));
ALTER TABLE "auto_install_applications" ADD CONSTRAINT "auto_install_applications_subject_type_check" CHECK (subject_type in ('user','team'));
ALTER TABLE "egress_events" ADD CONSTRAINT "egress_events_decision_check" CHECK (decision in ('allow','deny'));
ALTER TABLE "call_log" ADD CONSTRAINT "call_log_outcome_check" CHECK (outcome in ('ok','tool_error','error','blocked','denied','rate_limited','input_required'));
ALTER TABLE "call_log" ADD CONSTRAINT "call_log_principal_type_check" CHECK (principal_type in ('user','service'));

-- Partial index for the idle-instance reaper (FOR UPDATE SKIP LOCKED claims, 8.6)
CREATE INDEX "instances_idle_idx" ON "instances" ("last_used_at") WHERE "state" = 'running';
-- Unread notifications per user
CREATE INDEX "notifications_user_unread_idx" ON "notifications" ("user_id", "created_at" DESC) WHERE "read_at" IS NULL;
-- Audit filters (15.6)
CREATE INDEX "audit_events_ts_idx" ON "audit_events" ("ts" DESC);
CREATE INDEX "audit_events_target_idx" ON "audit_events" ("target_type", "target_id");
-- (scope, owner_id, name) cannot make org/system secrets unique: NULL owners are distinct in Postgres
CREATE UNIQUE INDEX "secrets_scope_name_ownerless_key" ON "secrets" ("scope", "name") WHERE "owner_id" IS NULL;
ALTER TABLE "registry_sources" ADD CONSTRAINT "registry_sources_trust_check" CHECK (trust in ('official','internal','community'));
ALTER TABLE "registry_servers" ADD CONSTRAINT "registry_servers_status_check" CHECK (status in ('active','deprecated','deleted'));
-- at most one org-default guard profile (13.1)
CREATE UNIQUE INDEX "guard_profiles_single_default_key" ON "guard_profiles" ("is_org_default") WHERE "is_org_default";
