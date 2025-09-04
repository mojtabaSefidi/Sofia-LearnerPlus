-- .github/scripts/db-setup-enhanced.sql
-- Enhanced database schema with duplicate contributor management

-- Contributors table (updated)
CREATE TABLE IF NOT EXISTS contributors (
  id SERIAL PRIMARY KEY,
  github_login VARCHAR(255) NOT NULL UNIQUE,
  canonical_name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  is_primary BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
);

-- Duplicate contributors mapping table
CREATE TABLE IF NOT EXISTS duplicate_contributors (
  id SERIAL PRIMARY KEY,
  primary_contributor_id INTEGER REFERENCES contributors(id) ON DELETE CASCADE,
  github_login VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  canonical_name VARCHAR(255),
  similarity_score DECIMAL(3,2), -- For tracking auto-detected duplicates
  merge_priority VARCHAR(20) DEFAULT 'manual', -- 'manual', 'auto-high', 'auto-medium'
  is_merged BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
  notes TEXT
);

-- Files table
CREATE TABLE IF NOT EXISTS files (
  id SERIAL PRIMARY KEY,
  canonical_path VARCHAR(500) UNIQUE NOT NULL,
  current_path VARCHAR(500) NOT NULL,
  file_type VARCHAR(50),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
);

-- File history for tracking renames and changes
CREATE TABLE IF NOT EXISTS file_history (
  id SERIAL PRIMARY KEY,
  file_id INTEGER REFERENCES files(id),
  old_path VARCHAR(500),
  new_path VARCHAR(500) NOT NULL,
  change_type VARCHAR(50) NOT NULL, -- 'added', 'modified', 'deleted', 'renamed'
  commit_sha VARCHAR(100) NOT NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
);

-- Enhanced contributions table
CREATE TABLE IF NOT EXISTS contributions (
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
  lines_deleted INTEGER DEFAULT 0,
  -- Prevent duplicate contributions
  UNIQUE(contributor_id, file_id, activity_type, activity_id, contribution_date)
);

-- Pull requests table (enhanced)
CREATE TABLE IF NOT EXISTS pull_requests (
  id SERIAL PRIMARY KEY,
  pr_number INTEGER NOT NULL UNIQUE,
  status VARCHAR(50) NOT NULL, -- 'open', 'closed', 'merged', 'draft'
  author_login VARCHAR(255) NOT NULL,
  reviewers jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_date TIMESTAMP WITHOUT TIME ZONE NOT NULL,
  merged_date TIMESTAMP WITHOUT TIME ZONE,
  closed_date TIMESTAMP WITHOUT TIME ZONE,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
  lines_modified INTEGER DEFAULT 0,
  is_processed BOOLEAN DEFAULT false -- Track processing status
);

-- Review comments table (enhanced)
CREATE TABLE IF NOT EXISTS review_comments (
  id SERIAL PRIMARY KEY,
  contributor_id INTEGER NOT NULL REFERENCES contributors(id),
  pr_number INTEGER NOT NULL,
  comment_date TIMESTAMP WITHOUT TIME ZONE NOT NULL,
  comment_text TEXT,
  comment_type VARCHAR(50) DEFAULT 'review', -- 'review', 'pr_comment', 'inline'
  is_bot_comment BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
  -- Prevent duplicate comments
  UNIQUE(contributor_id, pr_number, comment_date, comment_text)
);

-- Repository metadata (enhanced)
CREATE TABLE IF NOT EXISTS repository_metadata (
  id SERIAL PRIMARY KEY,
  key VARCHAR(255) UNIQUE NOT NULL,
  value TEXT NOT NULL,
  metadata_type VARCHAR(50) DEFAULT 'string',
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
);

-- Processing status tracking
CREATE TABLE IF NOT EXISTS processing_status (
  id SERIAL PRIMARY KEY,
  process_type VARCHAR(50) NOT NULL, -- 'initialization', 'incremental', 'pr_sync'
  status VARCHAR(50) NOT NULL, -- 'running', 'completed', 'failed'
  started_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
  completed_at TIMESTAMP WITHOUT TIME ZONE,
  metadata jsonb DEFAULT '{}'::jsonb,
  error_message TEXT
);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_contributions_contributor_file ON contributions(contributor_id, file_id);
CREATE INDEX IF NOT EXISTS idx_contributions_date ON contributions(contribution_date);
CREATE INDEX IF NOT EXISTS idx_contributions_pr ON contributions(pr_number);
CREATE INDEX IF NOT EXISTS idx_pull_requests_status ON pull_requests(status);
CREATE INDEX IF NOT EXISTS idx_pull_requests_author ON pull_requests(author_login);
CREATE INDEX IF NOT EXISTS idx_review_comments_pr ON review_comments(pr_number);
CREATE INDEX IF NOT EXISTS idx_duplicate_contributors_primary ON duplicate_contributors(primary_contributor_id);
CREATE INDEX IF NOT EXISTS idx_duplicate_contributors_login ON duplicate_contributors(github_login);

-- Functions for duplicate contributor management
CREATE OR REPLACE FUNCTION get_primary_contributor_id(input_login VARCHAR, input_email VARCHAR, input_name VARCHAR)
RETURNS INTEGER AS $$
DECLARE
  primary_id INTEGER;
  duplicate_id INTEGER;
BEGIN
  -- First check if it's already a primary contributor
  SELECT id INTO primary_id 
  FROM contributors 
  WHERE github_login = input_login AND is_primary = true;
  
  IF primary_id IS NOT NULL THEN
    RETURN primary_id;
  END IF;
  
  -- Check if it's mapped as a duplicate
  SELECT primary_contributor_id INTO primary_id
  FROM duplicate_contributors 
  WHERE github_login = input_login 
     OR email = input_email
     OR canonical_name = input_name;
  
  IF primary_id IS NOT NULL THEN
    RETURN primary_id;
  END IF;
  
  -- Check for similar contributors (this would need more complex logic)
  -- For now, return NULL to indicate no match found
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_contributors_updated_at BEFORE UPDATE ON contributors
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_pull_requests_updated_at BEFORE UPDATE ON pull_requests
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
