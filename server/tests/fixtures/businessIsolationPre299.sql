-- Synthetic pre-299 subset, not a schema dump or a full migration-chain fixture.
-- The runner installs the unchanged migration 299 over these real PostgreSQL tables.
CREATE TABLE users(id serial PRIMARY KEY, email text, password text, name text);
CREATE TABLE company_settings(
  id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id),
  name text, company_name text, is_default boolean NOT NULL DEFAULT false
);
CREATE TABLE chat_threads(
  id serial PRIMARY KEY, user_id integer REFERENCES users(id), business_id integer,
  title text
);
CREATE TABLE content_assets(
  id serial PRIMARY KEY, user_id integer REFERENCES users(id),
  thread_id integer REFERENCES chat_threads(id), parent_asset_id integer REFERENCES content_assets(id),
  type text, title text, content text, channel text, status text
);
CREATE TABLE knowledge_documents(
  id serial PRIMARY KEY, user_id integer REFERENCES users(id), source_type text, title text
);
CREATE TABLE support_teams(
  id serial PRIMARY KEY, user_id integer REFERENCES users(id), name text,
  is_active boolean NOT NULL DEFAULT true, created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE support_tickets(
  id serial PRIMARY KEY, user_id integer REFERENCES users(id),
  team_id integer REFERENCES support_teams(id), ticket_number text, subject text
);
CREATE TABLE ai_settings(
  id serial PRIMARY KEY, user_id integer NOT NULL UNIQUE REFERENCES users(id),
  ai_provider varchar(50) DEFAULT 'openai', ai_model text DEFAULT 'gpt-4',
  image_provider varchar(50) DEFAULT 'google', image_model text DEFAULT 'gemini-2.5-flash-image',
  video_provider varchar(50) DEFAULT 'google', video_model text DEFAULT 'veo-3.1-fast-generate-001',
  temperature real DEFAULT 0.7, max_tokens integer DEFAULT 2000,
  enable_auto_response boolean DEFAULT true, enable_learning boolean DEFAULT true,
  response_delay real DEFAULT 1, confidence_threshold real DEFAULT 0.8,
  created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now()
);
CREATE TABLE content_templates(
  id serial PRIMARY KEY, user_id integer REFERENCES users(id), name text, type text, content text,
  is_predefined boolean NOT NULL DEFAULT false, is_approved boolean NOT NULL DEFAULT false
);
CREATE TABLE content_template_versions(
  id serial PRIMARY KEY, user_id integer REFERENCES users(id),
  template_id integer REFERENCES content_templates(id), version integer, snapshot jsonb
);
-- These are migration 299's unconditional legacy-backfill inputs.
CREATE TABLE ai_visibility_projects(
  id serial PRIMARY KEY, user_id integer REFERENCES users(id), status text
);
CREATE TABLE meta_page_connections(
  id serial PRIMARY KEY, user_id integer REFERENCES users(id), page_id text, instagram_account_id text
);
CREATE TABLE webhook_events(
  id serial PRIMARY KEY, user_id integer REFERENCES users(id), page_id text, platform text, event_type text
);
CREATE TABLE instagram_webhook_events(
  id serial PRIMARY KEY, user_id integer REFERENCES users(id), page_id text
);
