-- .github/scripts/db-setup.sql

-- Contributors table - Remove unique constraint on github_login to allow duplicates initially
CREATE TABLE contributors (
    id SERIAL PRIMARY KEY,
    github_login VARCHAR(255) NOT NULL,
    canonical_name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Files table
CREATE TABLE files (
    id SERIAL PRIMARY KEY,
    canonical_path VARCHAR(500) UNIQUE NOT NULL,
    current_path VARCHAR(500) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- File history for tracking renames
CREATE TABLE file_history (
    id SERIAL PRIMARY KEY,
    file_id INTEGER REFERENCES files(id),
    old_path VARCHAR(500),
    new_path VARCHAR(500) NOT NULL,
    change_type VARCHAR(50) NOT NULL, -- 'added', 'modified', 'deleted', 'renamed'
    commit_sha VARCHAR(40) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Contributions table
CREATE TABLE contributions (
    id SERIAL PRIMARY KEY,
    contributor_id INTEGER REFERENCES contributors(id),
    file_id INTEGER REFERENCES files(id),
    activity_type VARCHAR(50) NOT NULL, -- 'commit', 'review'
    activity_id VARCHAR(100) NOT NULL, -- commit sha or PR number
    contribution_date TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Pull requests table
CREATE TABLE pull_requests (
    id SERIAL PRIMARY KEY,
    pr_number INTEGER NOT NULL,
    status VARCHAR(50) NOT NULL, -- 'open', 'closed', 'merged'
    author_login VARCHAR(255) NOT NULL,
    created_date TIMESTAMP NOT NULL,
    merged_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Repository metadata
CREATE TABLE repository_metadata (
    id SERIAL PRIMARY KEY,
    key VARCHAR(100) UNIQUE NOT NULL,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_contributions_contributor ON contributions(contributor_id);
CREATE INDEX idx_contributions_file ON contributions(file_id);
CREATE INDEX idx_contributions_activity ON contributions(activity_type, activity_id);
CREATE INDEX idx_file_history_file ON file_history(file_id);
CREATE INDEX idx_contributors_login ON contributors(github_login);
CREATE INDEX idx_contributors_email ON contributors(email);
