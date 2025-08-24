-- .github/scripts/db-setup.sql
-- Database schema aligned to provided schema (*)

-- Contributors table
CREATE TABLE contributors (
  id SERIAL PRIMARY KEY,
  github_login VARCHAR(255) NOT NULL,
  canonical_name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
);

-- Files table
CREATE TABLE files (
  id SERIAL PRIMARY KEY,
  canonical_path VARCHAR(500) UNIQUE NOT NULL,
  current_path VARCHAR(500) NOT NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
);

-- File history for tracking renames and changes
CREATE TABLE file_history (
  id SERIAL PRIMARY KEY,
  file_id INTEGER REFERENCES files(id),
  old_path VARCHAR(500),
  new_path VARCHAR(500) NOT NULL,
  change_type VARCHAR(50) NOT NULL, -- 'added', 'modified', 'deleted', 'renamed'
  commit_sha VARCHAR(100) NOT NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
);

-- Enhanced contributions table matching your schema
CREATE TABLE contributions (
  id SERIAL PRIMARY KEY,
  contributor_id INTEGER REFERENCES contributors(id),
  file_id INTEGER REFERENCES files(id),
  activity_type VARCHAR(50) NOT NULL, -- 'commit', 'review', etc.
  activity_id VARCHAR(100) NOT NULL, -- commit sha or PR identifier
  contribution_date TIMESTAMP WITHOUT TIME ZONE NOT NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
  lines_modified INTEGER DEFAULT 0,
  pr_number INTEGER,
  lines_added INTEGER DEFAULT 0,
  lines_deleted INTEGER DEFAULT 0
);

-- Pull requests table
CREATE TABLE pull_requests (
  id SERIAL PRIMARY KEY,
  pr_number INTEGER NOT NULL UNIQUE,
  status VARCHAR(50) NOT NULL, -- 'open', 'closed', 'merged'
  author_login VARCHAR(255) NOT NULL,
  reviewers jsonb NOT NULL DEFAULT '[]'::jsonb, -- array of reviewer objects
  created_date TIMESTAMP WITHOUT TIME ZONE NOT NULL,
  merged_date TIMESTAMP WITHOUT TIME ZONE,
  closed_date TIMESTAMP WITHOUT TIME ZONE,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
  lines_modified INTEGER DEFAULT 0
);

-- table for review comments
CREATE TABLE review_comments (
  id SERIAL PRIMARY KEY,
  contributor_id INT NOT NULL REFERENCES contributors(id),
  pr_number INT NOT NULL REFERENCES pull_requests(pr_number),
  comment_date timestamp without time zone NOT NULL,
  comment_text TEXT,
  created_at timestamp without time zone DEFAULT now(),
);

-- Repository metadata
CREATE TABLE repository_metadata (
  id SERIAL PRIMARY KEY,
  key VARCHAR UNIQUE NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_contributions_contributor ON contributions(contributor_id);
CREATE INDEX IF NOT EXISTS idx_contributions_file ON contributions(file_id);
CREATE INDEX IF NOT EXISTS idx_contributions_activity ON contributions(activity_type, activity_id);
CREATE INDEX IF NOT EXISTS idx_contributions_date ON contributions(contribution_date);
CREATE INDEX IF NOT EXISTS idx_contributions_contributor_file ON contributions(contributor_id, file_id);
CREATE INDEX IF NOT EXISTS idx_file_history_file ON file_history(file_id);
CREATE INDEX IF NOT EXISTS idx_contributors_login ON contributors(github_login);
CREATE INDEX IF NOT EXISTS idx_contributors_email ON contributors(email);
CREATE INDEX IF NOT EXISTS idx_files_current_path ON files(current_path);
CREATE INDEX IF NOT EXISTS idx_files_canonical_path ON files(canonical_path);
CREATE INDEX IF NOT EXISTS idx_pull_requests_pr_number ON pull_requests(pr_number);

-- View for easier querying of file expertise
CREATE OR REPLACE VIEW file_expertise AS
SELECT
  f.id AS file_id,
  f.current_path,
  f.canonical_path,
  c.id AS contributor_id,
  c.github_login,
  c.canonical_name,
  COUNT(*) AS total_contributions,
  COUNT(*) FILTER (WHERE co.activity_type = 'commit') AS total_commits,
  COUNT(*) FILTER (WHERE co.activity_type = 'review') AS total_reviews,
  MAX(co.contribution_date) AS last_contribution,
  MIN(co.contribution_date) AS first_contribution
FROM files f
JOIN contributions co ON f.id = co.file_id
JOIN contributors c ON co.contributor_id = c.id
GROUP BY f.id, f.current_path, f.canonical_path, c.id, c.github_login, c.canonical_name;

-- View for recent activity (last year)
CREATE OR REPLACE VIEW recent_activity AS
SELECT
  co.contributor_id,
  c.github_login,
  c.canonical_name,
  co.activity_type,
  COUNT(*) AS activity_count,
  COUNT(DISTINCT co.file_id) AS files_touched,
  COUNT(DISTINCT DATE_TRUNC('month', co.contribution_date)) AS active_months
FROM contributions co
JOIN contributors c ON co.contributor_id = c.id
WHERE co.contribution_date >= NOW() - INTERVAL '1 year'
GROUP BY co.contributor_id, c.github_login, c.canonical_name, co.activity_type;
