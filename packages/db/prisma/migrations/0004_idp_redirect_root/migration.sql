-- IdPs that accept only the origin of the site as a redirect URI (Synology SSO Server): the sign-in returns to the
-- site root instead of /auth/callback/{connection id} (9.1).
ALTER TABLE "idp_connections" ADD COLUMN "redirect_to_root" BOOLEAN NOT NULL DEFAULT false;
