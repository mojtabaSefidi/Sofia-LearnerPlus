// .github/scripts/migrate-database.js
// Run this script to migrate existing data to support new workload analytics

const { createClient } = require('@supabase/supabase-js');
const core = require('@actions/core');
const github = require('@actions/github');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function migrateDatabaseForWorkloadAnalytics() {
  console.log('🔄 Starting database migration for workload analytics...');
  
  try {
    // Step 1: Add missing columns to existing tables
    console.log('📝 Adding missing columns...');
    
    // These ALTER TABLE statements should be run manually in Supabase SQL editor
    // as they require admin privileges
    console.log(`
Please run these SQL commands in your Supabase SQL editor:

-- Add columns to contributions table
ALTER TABLE contributions 
ADD COLUMN IF NOT EXISTS lines_modified INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS pr_number INTEGER;

-- Add columns to pull_requests table  
ALTER TABLE pull_requests 
ADD COLUMN IF NOT EXISTS lines_modified INTEGER DEFAULT 0;

-- Create pr_reviews table if not exists
CREATE TABLE IF NOT EXISTS pr_reviews (
    id SERIAL PRIMARY KEY,
    pr_number INTEGER NOT NULL,
    reviewer_login VARCHAR(255) NOT NULL,
    pr_opened_date TIMESTAMP NOT NULL,
    pr_closed_date TIMESTAMP,
    lines_modified INTEGER DEFAULT 0,
    review_submitted_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(pr_number, reviewer_login)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_pr_reviews_reviewer ON pr_reviews(reviewer_login);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_pr_number ON pr_reviews(pr_number);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_dates ON pr_reviews(pr_opened_date, pr_closed_date);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_review_date ON pr_reviews(review_submitted_date);

-- Create views
CREATE OR REPLACE VIEW quarterly_workload AS
SELECT 
    c.github_login,
    c.canonical_name,
    COUNT(*) FILTER (WHERE co.activity_type = 'review' AND co.contribution_date >= NOW() - INTERVAL '3 months') as quarterly_reviews,
    COUNT(*) FILTER (WHERE co.activity_type = 'commit' AND co.contribution_date >= NOW() - INTERVAL '3 months') as quarterly_commits,
    SUM(co.lines_modified) FILTER (WHERE co.activity_type = 'review' AND co.contribution_date >= NOW() - INTERVAL '3 months') as quarterly_lines_reviewed,
    MAX(co.contribution_date) FILTER (WHERE co.activity_type = 'review') as last_review_date,
    MAX(co.contribution_date) FILTER (WHERE co.activity_type = 'commit') as last_commit_date
FROM contributors c
LEFT JOIN contributions co ON c.id = co.contributor_id
GROUP BY c.id, c.github_login, c.canonical_name;

CREATE OR REPLACE VIEW pr_performance_metrics AS
SELECT 
    reviewer_login,
    COUNT(*) as total_prs_reviewed,
    AVG(EXTRACT(EPOCH FROM (pr_closed_date - pr_opened_date))/3600) as avg_review_time_hours,
    AVG(lines_modified) as avg_review_size_lines,
    AVG(lines_modified::FLOAT / NULLIF(EXTRACT(EPOCH FROM (pr_closed_date - pr_opened_date))/3600, 0)) as lines_per_hour,
    MAX(review_submitted_date) as last_review_activity
FROM pr_reviews 
WHERE pr_closed_date IS NOT NULL 
AND pr_opened_date >= NOW() - INTERVAL '3 months'
GROUP BY reviewer_login;
`);

    // Step 2: Backfill PR data if GitHub token is available
    if (process.env.GITHUB_TOKEN) {
      console.log('🔍 Backfilling historical PR data...');
      await backfillPRData();
    } else {
      console.log('ℹ️ Skipping PR data backfill (no GitHub token provided)');
    }

    // Step 3: Update repository metadata
    await updateMetadata('migration_workload_analytics', new Date().toISOString());
    
    console.log('✅ Database migration completed successfully!');
    
  } catch (error) {
    console.error('❌ Error during migration:', error);
    core.setFailed(error.message);
  }
}

async function backfillPRData() {
  const token = process.env.GITHUB_TOKEN;
  const octokit = github.getOctokit(token);
  
  // Get repository info from environment or context
  const owner = process.env.GITHUB_REPOSITORY_OWNER || 'your-org';
  const repo = process.env.GITHUB_REPOSITORY_NAME || 'your-repo';
  
  try {
    // Get closed PRs from last 3 months
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    
    console.log(`📥 Fetching PRs since ${threeMonthsAgo.toISOString()}...`);
    
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'closed',
      since: threeMonthsAgo.toISOString(),
      per_page: 100
    });
    
    console.log(`📊 Found ${prs.length} PRs to process`);
    
    for (const pr of prs) {
      if (pr.merged_at) {
        console.log(`🔄 Processing PR #${pr.number}...`);
        await backfillSinglePR(pr, owner, repo, octokit);
      }
    }
    
  } catch (error) {
    console.warn('⚠️ Could not backfill PR data:', error.message);
  }
}

async function backfillSinglePR(pr, owner, repo, octokit) {
  try {
    // Get PR files and reviews
    const [filesResponse, reviewsResponse] = await Promise.all([
      octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pr.number
      }),
      octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: pr.number
      })
    ]);
    
    const files = filesResponse.data;
    const reviews = reviewsResponse.data;
    
    // Calculate total lines modified
    const totalLinesModified = files.reduce((total, file) => {
      return total + (file.additions || 0) + (file.deletions || 0);
    }, 0);
    
    // Record PR in pull_requests table
    const { error: prError } = await supabase
      .from('pull_requests')
      .upsert({
        pr_number: pr.number,
        status: pr.merged_at ? 'merged' : 'closed',
        author_login: pr.user.login,
        created_date: new Date(pr.created_at),
        merged_date: pr.merged_at ? new Date(pr.merged_at) : null,
        closed_date: pr.closed_at ? new Date(pr.closed_at) : null,
        lines_modified: totalLinesModified
      }, {
        onConflict: 'pr_number'
      });
    
    if (prError) {
      console.warn(`⚠️ Error recording PR #${pr.number}:`, prError.message);
    }
    
    // Record PR reviews
    for (const review of reviews) {
      if (review.user.login !== pr.user.login) {
        const { error: reviewError } = await supabase
          .from('pr_reviews')
          .upsert({
            pr_number: pr.number,
            reviewer_login: review.user.login,
            pr_opened_date: new Date(pr.created_at),
            pr_closed_date: pr.merged_at ? new Date(pr.merged_at) : (pr.closed_at ? new Date(pr.closed_at) : null),
            lines_modified: totalLinesModified,
            review_submitted_date: new Date(review.submitted_at)
          }, {
            onConflict: 'pr_number,reviewer_login'
          });
        
        if (reviewError) {
          console.warn(`⚠️ Error recording review for PR #${pr.number}:`, reviewError.message);
        }
      }
    }
    
  } catch (error) {
    console.warn(`⚠️ Error processing PR #${pr.number}:`, error.message);
  }
}

async function updateMetadata(key, value) {
  const { error } = await supabase
    .from('repository_metadata')
    .upsert({ key, value }, { onConflict: 'key' });
    
  if (error) {
    console.warn('Error updating metadata:', error.message);
  }
}

// Run if called directly
if (require.main === module) {
  migrateDatabaseForWorkloadAnalytics();
}

module.exports = { migrateDatabaseForWorkloadAnalytics };
