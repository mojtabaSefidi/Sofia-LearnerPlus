-- .github/scripts/db-setup.sql
-- Enhanced database schema for detailed PR analysis

-- Contributors table
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

-- File history for tracking renames and changes
CREATE TABLE file_history (
    id SERIAL PRIMARY KEY,
    file_id INTEGER REFERENCES files(id),
    old_path VARCHAR(500),
    new_path VARCHAR(500) NOT NULL,
    change_type VARCHAR(50) NOT NULL, -- 'added', 'modified', 'deleted', 'renamed'
    commit_sha VARCHAR(40) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Enhanced contributions table with more detailed tracking
CREATE TABLE contributions (
    id SERIAL PRIMARY KEY,
    contributor_id INTEGER REFERENCES contributors(id),
    file_id INTEGER REFERENCES files(id),
    activity_type VARCHAR(50) NOT NULL, -- 'commit', 'review'
    activity_id VARCHAR(100) NOT NULL, -- commit sha or PR number
    contribution_date TIMESTAMP NOT NULL,
    lines_added INTEGER DEFAULT 0, -- For commits
    lines_deleted INTEGER DEFAULT 0, -- For commits
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
    closed_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Repository metadata
CREATE TABLE repository_metadata (
    id SERIAL PRIMARY KEY,
    key VARCHAR(100) UNIQUE NOT NULL,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX idx_contributions_contributor ON contributions(contributor_id);
CREATE INDEX idx_contributions_file ON contributions(file_id);
CREATE INDEX idx_contributions_activity ON contributions(activity_type, activity_id);
CREATE INDEX idx_contributions_date ON contributions(contribution_date);
CREATE INDEX idx_contributions_contributor_file ON contributions(contributor_id, file_id);
CREATE INDEX idx_file_history_file ON file_history(file_id);
CREATE INDEX idx_contributors_login ON contributors(github_login);
CREATE INDEX idx_contributors_email ON contributors(email);
CREATE INDEX idx_files_current_path ON files(current_path);
CREATE INDEX idx_files_canonical_path ON files(canonical_path);

-- View for easier querying of file expertise
CREATE VIEW file_expertise AS
SELECT 
    f.id as file_id,
    f.current_path,
    f.canonical_path,
    c.id as contributor_id,
    c.github_login,
    c.canonical_name,
    COUNT(*) as total_contributions,
    COUNT(*) FILTER (WHERE co.activity_type = 'commit') as total_commits,
    COUNT(*) FILTER (WHERE co.activity_type = 'review') as total_reviews,
    MAX(co.contribution_date) as last_contribution,
    MIN(co.contribution_date) as first_contribution
FROM files f
JOIN contributions co ON f.id = co.file_id
JOIN contributors c ON co.contributor_id = c.id
GROUP BY f.id, f.current_path, f.canonical_path, c.id, c.github_login, c.canonical_name;

-- View for recent activity (last year)
CREATE VIEW recent_activity AS
SELECT 
    contributor_id,
    c.github_login,
    c.canonical_name,
    activity_type,
    COUNT(*) as activity_count,
    COUNT(DISTINCT file_id) as files_touched,
    COUNT(DISTINCT DATE_TRUNC('month', contribution_date)) as active_months
FROM contributions co
JOIN contributors c ON co.contributor_id = c.id
WHERE contribution_date >= NOW() - INTERVAL '1 year'
GROUP BY contributor_id, c.github_login, c.canonical_name, activity_type;
