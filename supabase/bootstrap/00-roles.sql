-- LOCAL DEVELOPMENT ONLY. Executed once by the postgres:16 container on first
-- start (docker-compose mounts this folder as /docker-entrypoint-initdb.d).
--
-- Two roles (ADR-0005):
--   dolmir_owner  owns every object and runs migrations
--   dolmir_app    the API's runtime role: cannot bypass RLS, owns nothing
--
-- On Supabase these roles are created once through the SQL editor with real
-- passwords; the migrations themselves never create login roles.
CREATE ROLE dolmir_owner LOGIN PASSWORD 'dolmir_owner_dev' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;
CREATE ROLE dolmir_app   LOGIN PASSWORD 'dolmir_app_dev'   NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;

ALTER DATABASE dolmir OWNER TO dolmir_owner;
