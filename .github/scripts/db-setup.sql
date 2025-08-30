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
