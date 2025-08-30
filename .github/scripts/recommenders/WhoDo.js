const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function whoDo_suggestion(
  prAuthor,
  prFiles,
  prCreatedAt = null,
  prClosedAt = null,
  prNumber = null,
  topN = 20,
  C1 = 1.0,
  C2 = 1.0,
  C3 = 1.0,
  C4 = 1.0,
  theta = 0.5
) {
  console.log('🔬 Running whoDo_suggestion...');

  // Validation
  if (!prFiles || !Array.isArray(prFiles) || prFiles.length === 0) {
    return [];
  }
  
  const filePaths = prFiles.map(f => f.filename);
  const prRefDate = prCreatedAt ? new Date(prCreatedAt) : new Date();
  const prClosedDate = prClosedAt ? new Date(prClosedAt) : null;
  
  if (isNaN(prRefDate.getTime())) {
    throw new Error('Invalid prCreatedAt date');
  }

  try {
    // Phase A: Candidate set & mapping
    console.log('Phase A: Building candidate set...');
    
    // Map PR author to contributor id and get all candidates
    const { data: contributors, error: contribErr } = await supabase
      .from('contributors')
      .select('id, github_login, canonical_name');

    if (contribErr) {
      console.error('Error fetching contributors:', contribErr);
      throw contribErr;
    }

    // Build candidates map (exclude PR author)
    const candidatesMap = new Map();
    let authorId = null;
    
    for (const c of contributors || []) {
      if (c.github_login && c.github_login.toLowerCase() === String(prAuthor).toLowerCase()) {
        authorId = c.id;
        continue; // Exclude author from candidates
      }
      candidatesMap.set(c.id, {
        id: c.id,
        login: c.github_login,
        canonical_name: c.canonical_name
      });
    }

    if (candidatesMap.size === 0) {
      return [];
    }

    // Map PR file paths to file IDs
    const { data: fileRows, error: fileErr } = await supabase
      .from('files')
      .select('id, canonical_path')
      .in('canonical_path', filePaths);

    if (fileErr) {
      console.error('Error fetching files:', fileErr);
      throw fileErr;
    }

    const F_fileids = new Set();
    const filePathToIdMap = new Map();
    
    for (const f of fileRows || []) {
      F_fileids.add(f.id);
      filePathToIdMap.set(f.canonical_path, f.id);
    }

    if (F_fileids.size === 0) {
      console.log('No matching files found in database');
      return [];
    }

    // Phase B: Build P (parent directories) and files in those directories
    console.log('Phase B: Computing parent directories...');
    
    const P_dirs = new Set();
    
    // Compute last-level parent directory for each file
    for (const filePath of filePaths) {
      const lastSlashIndex = filePath.lastIndexOf('/');
      if (lastSlashIndex > 0) {
        const parentDir = filePath.substring(0, lastSlashIndex);
        P_dirs.add(parentDir);
      }
    }

    // Get all file IDs that live in each parent directory
    const fileIdsInDirs = new Map(); // parentDir -> Set(file_ids)
    
    if (P_dirs.size > 0) {
      const { data: allFileRows, error: allFileErr } = await supabase
        .from('files')
        .select('id, canonical_path');

      if (allFileErr) {
        console.error('Error fetching all files:', allFileErr);
        throw allFileErr;
      }

      for (const f of allFileRows || []) {
        const filePath = f.canonical_path;
        const lastSlashIndex = filePath.lastIndexOf('/');
        if (lastSlashIndex > 0) {
          const parentDir = filePath.substring(0, lastSlashIndex);
          if (P_dirs.has(parentDir)) {
            if (!fileIdsInDirs.has(parentDir)) {
              fileIdsInDirs.set(parentDir, new Set());
            }
            fileIdsInDirs.get(parentDir).add(f.id);
          }
        }
      }
    }

    // Phase C: Per-file and per-directory activity counts & recency
    console.log('Phase C: Computing activity counts and recency...');
    
    // Fetch all contributions for scoring (no date restrictions for historical data)
    const { data: allContributions, error: contribHistErr } = await supabase
      .from('contributions')
      .select('contributor_id, file_id, activity_type, contribution_date')
      .in('activity_type', ['commit', 'review'])
      .lt('contribution_date', prRefDate.toISOString()); // Only consider contributions before PR

    if (contribHistErr) {
      console.error('Error fetching all contributions:', contribHistErr);
      throw contribHistErr;
    }

    // Organize contributions by contributor and file/activity type
    const contribByDevFileActivity = new Map(); // "devId_fileId_activityType" -> contributions[]
    
    for (const contrib of allContributions || []) {
      const key = `${contrib.contributor_id}_${contrib.file_id}_${contrib.activity_type}`;
      if (!contribByDevFileActivity.has(key)) {
        contribByDevFileActivity.set(key, []);
      }
      contribByDevFileActivity.get(key).push(contrib);
    }

    // Helper function to calculate days difference
    const daysDiff = (date1, date2) => {
      const diffTime = Math.abs(date1.getTime() - date2.getTime());
      return Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    };

    // Calculate scores for each candidate
    const candidateScores = new Map();
    
    for (const [devId, devMeta] of candidatesMap) {
      let sumFileCommits = 0;
      let sumFileReviews = 0;
      let sumDirCommits = 0;
      let sumDirReviews = 0;

      // File-level calculations
      for (const fileId of F_fileids) {
        // File commits
        const commitKey = `${devId}_${fileId}_commit`;
        const commits = contribByDevFileActivity.get(commitKey) || [];
        const nChangeFile = commits.length;
        
        if (nChangeFile > 0) {
          const lastChangeDate = new Date(Math.max(...commits.map(c => new Date(c.contribution_date).getTime())));
          const tChangeFile = daysDiff(prRefDate, lastChangeDate);
          // Avoid division by zero: tChangeFile is guaranteed >= 1 by daysDiff function
          sumFileCommits += nChangeFile / tChangeFile;
        }

        // File reviews
        const reviewKey = `${devId}_${fileId}_review`;
        const reviews = contribByDevFileActivity.get(reviewKey) || [];
        const nReviewFile = reviews.length;
        
        if (nReviewFile > 0) {
          const lastReviewDate = new Date(Math.max(...reviews.map(r => new Date(r.contribution_date).getTime())));
          const tReviewFile = daysDiff(prRefDate, lastReviewDate);
          // Avoid division by zero: tReviewFile is guaranteed >= 1 by daysDiff function
          sumFileReviews += nReviewFile / tReviewFile;
        }
      }

      // Directory-level calculations
      for (const parentDir of P_dirs) {
        const filesInDir = fileIdsInDirs.get(parentDir) || new Set();
        
        // Directory commits
        let nChangeDir = 0;
        let lastChangeDirDate = null;
        
        for (const fileId of filesInDir) {
          const commitKey = `${devId}_${fileId}_commit`;
          const commits = contribByDevFileActivity.get(commitKey) || [];
          nChangeDir += commits.length;
          
          if (commits.length > 0) {
            const fileLastChange = new Date(Math.max(...commits.map(c => new Date(c.contribution_date).getTime())));
            if (!lastChangeDirDate || fileLastChange > lastChangeDirDate) {
              lastChangeDirDate = fileLastChange;
            }
          }
        }
        
        if (nChangeDir > 0 && lastChangeDirDate) {
          const tChangeDir = daysDiff(prRefDate, lastChangeDirDate);
          // Avoid division by zero: tChangeDir is guaranteed >= 1 by daysDiff function
          sumDirCommits += nChangeDir / tChangeDir;
        }

        // Directory reviews
        let nReviewDir = 0;
        let lastReviewDirDate = null;
        
        for (const fileId of filesInDir) {
          const reviewKey = `${devId}_${fileId}_review`;
          const reviews = contribByDevFileActivity.get(reviewKey) || [];
          nReviewDir += reviews.length;
          
          if (reviews.length > 0) {
            const fileLastReview = new Date(Math.max(...reviews.map(r => new Date(r.contribution_date).getTime())));
            if (!lastReviewDirDate || fileLastReview > lastReviewDirDate) {
              lastReviewDirDate = fileLastReview;
            }
          }
        }
        
        if (nReviewDir > 0 && lastReviewDirDate) {
          const tReviewDir = daysDiff(prRefDate, lastReviewDirDate);
          // Avoid division by zero: tReviewDir is guaranteed >= 1 by daysDiff function
          sumDirReviews += nReviewDir / tReviewDir;
        }
      }

      // Phase D: Compute Score(D) using WhoDo formula
      const score = (C1 * sumFileCommits) + (C2 * sumDirCommits) + (C3 * sumFileReviews) + (C4 * sumDirReviews);
      
      candidateScores.set(devId, {
        devMeta,
        score,
        sumFileCommits,
        sumDirCommits,
        sumFileReviews,
        sumDirReviews
      });
    }

    // Phase E: Compute Load(D)
    console.log('Phase E: Computing workload...');
    
    // Find overlapping PRs
    const { data: overlappingPRs, error: prErr } = await supabase
      .from('pull_requests')
      .select('pr_number, author_login, created_date, closed_date, reviewers')
      .neq('pr_number', prNumber || -1); // Exclude current PR

    if (prErr) {
      console.error('Error fetching pull requests:', prErr);
      throw prErr;
    }

    // Filter overlapping PRs based on time windows
    const overlappingPRNumbers = new Set();
    
    for (const pr of overlappingPRs || []) {
      const prCreated = new Date(pr.created_date);
      const prClosed = pr.closed_date ? new Date(pr.closed_date) : null;
      
      // Check if PRs overlap
      const currentPRClosed = prClosedDate || new Date(); // Treat null as "now"
      
      // PR X overlaps current PR if:
      // X.created_date <= current_PR.closed_date AND X.closed_date >= current_PR.created_date
      const overlaps = prCreated <= currentPRClosed && 
                      (prClosed === null || prClosed >= prRefDate);
      
      if (overlaps) {
        overlappingPRNumbers.add(pr.pr_number);
      }
    }

    // Get review activities for overlapping PRs
    const loadByDev = new Map(); // devId -> totalOpenReviews count
    
    if (overlappingPRNumbers.size > 0) {
      // Check review_comments for review activity
      const { data: reviewComments, error: reviewErr } = await supabase
        .from('review_comments')
        .select('contributor_id, pr_number')
        .in('pr_number', Array.from(overlappingPRNumbers));

      if (reviewErr) {
        console.error('Error fetching review comments:', reviewErr);
        throw reviewErr;
      }

      // Count unique PRs each developer is reviewing
      const devReviewPRs = new Map(); // devId -> Set(pr_numbers)
      
      for (const comment of reviewComments || []) {
        if (!devReviewPRs.has(comment.contributor_id)) {
          devReviewPRs.set(comment.contributor_id, new Set());
        }
        devReviewPRs.get(comment.contributor_id).add(comment.pr_number);
      }

      // Also check contributions table for review activities
      const { data: reviewContribs, error: reviewContribErr } = await supabase
        .from('contributions')
        .select('contributor_id, pr_number')
        .in('pr_number', Array.from(overlappingPRNumbers))
        .eq('activity_type', 'review');

      if (reviewContribErr) {
        console.error('Error fetching review contributions:', reviewContribErr);
        throw reviewContribErr;
      }

      for (const contrib of reviewContribs || []) {
        if (contrib.pr_number) {
          if (!devReviewPRs.has(contrib.contributor_id)) {
            devReviewPRs.set(contrib.contributor_id, new Set());
          }
          devReviewPRs.get(contrib.contributor_id).add(contrib.pr_number);
        }
      }

      // Also check reviewers field in pull_requests table
      for (const pr of overlappingPRs || []) {
        if (overlappingPRNumbers.has(pr.pr_number) && pr.reviewers) {
          const reviewers = Array.isArray(pr.reviewers) ? pr.reviewers : [];
          for (const reviewer of reviewers) {
            const reviewerLogin = reviewer.login || reviewer;
            // Find contributor by login
            const contributor = Array.from(candidatesMap.values()).find(c => 
              c.login && c.login.toLowerCase() === String(reviewerLogin).toLowerCase()
            );
            if (contributor) {
              if (!devReviewPRs.has(contributor.id)) {
                devReviewPRs.set(contributor.id, new Set());
              }
              devReviewPRs.get(contributor.id).add(pr.pr_number);
            }
          }
        }
      }

      // Set load for each developer
      for (const [devId, prSet] of devReviewPRs) {
        loadByDev.set(devId, prSet.size);
      }
    }

    // Phase F: Final WhoDo score and return top k
    console.log('Phase F: Computing final scores...');
    
    const results = [];
    
    for (const [devId, scoreData] of candidateScores) {
      const totalOpenReviews = loadByDev.get(devId) || 0;
      const load = Math.exp(theta * totalOpenReviews);
      // Avoid division by zero: load is always >= 1 due to exp(0) = 1
      const whoDoScore = scoreData.score / load;

      results.push({
        login: scoreData.devMeta.login,
        canonical_name: scoreData.devMeta.canonical_name,
        contributor_id: devId,
        whoDoScore,
        rawScore: scoreData.score,
        load,
        totalOpenReviews,
        sumFileCommits: scoreData.sumFileCommits,
        sumDirCommits: scoreData.sumDirCommits,
        sumFileReviews: scoreData.sumFileReviews,
        sumDirReviews: scoreData.sumDirReviews
      });
    }

    // Sort by WhoDo score descending and return top k
    results.sort((a, b) => b.whoDoScore - a.whoDoScore);
    return results.slice(0, topN);

  } catch (error) {
    console.error('Error in whoDo_suggestion:', error);
    throw error;
  }
}

// Helper function to get parent directory path
function getParentDirectory(filePath) {
  const lastSlashIndex = filePath.lastIndexOf('/');
  return lastSlashIndex > 0 ? filePath.substring(0, lastSlashIndex) : '';
}

// Helper function to calculate days between dates (ensures minimum of 1 to avoid division by zero)
function calculateDaysDiff(laterDate, earlierDate) {
  const diffTime = Math.abs(laterDate.getTime() - earlierDate.getTime());
  const days = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return Math.max(1, days); // Ensures we never return 0, avoiding division by zero
}

module.exports = {
  whoDo_suggestion,
  getParentDirectory,
  calculateDaysDiff
};
