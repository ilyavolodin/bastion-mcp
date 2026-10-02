-- apps/server runtime needs. call_log.origin tags rows of /mcp/c/{catalogSlug} calls as plugin traffic (7.1, 25.8).
-- ALTER TABLE on the partitioned parent propagates to every existing and future partition.
ALTER TABLE "call_log" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE "call_log" ADD CONSTRAINT "call_log_origin_check" CHECK (origin in ('direct','plugin'));
