-- Runs once, as the Postgres superuser, when the container's data volume is first created.
-- Dev passwords only. In production, create these roles through your managed-DB console/IaC.
--
--   softlife_owner  : owns the schema; used ONLY to run migrations
--   softlife_app    : the API's tenant role. RLS policies confine it to app.current_org_id
--   softlife_system : auth lookups + outbox relay. Gets explicit "see everything" policies,
--                     so no BYPASSRLS attribute is needed (not grantable on some managed DBs)

CREATE ROLE softlife_owner  LOGIN PASSWORD 'owner_dev_password';
CREATE ROLE softlife_app    LOGIN PASSWORD 'app_dev_password';
CREATE ROLE softlife_system LOGIN PASSWORD 'system_dev_password';

CREATE DATABASE softlife      OWNER softlife_owner;
CREATE DATABASE softlife_test OWNER softlife_owner;

\connect softlife
ALTER SCHEMA public OWNER TO softlife_owner;
GRANT USAGE ON SCHEMA public TO softlife_app, softlife_system;
ALTER DEFAULT PRIVILEGES FOR ROLE softlife_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO softlife_app, softlife_system;
ALTER DEFAULT PRIVILEGES FOR ROLE softlife_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO softlife_app, softlife_system;

\connect softlife_test
ALTER SCHEMA public OWNER TO softlife_owner;
GRANT USAGE ON SCHEMA public TO softlife_app, softlife_system;
ALTER DEFAULT PRIVILEGES FOR ROLE softlife_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO softlife_app, softlife_system;
ALTER DEFAULT PRIVILEGES FOR ROLE softlife_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO softlife_app, softlife_system;
