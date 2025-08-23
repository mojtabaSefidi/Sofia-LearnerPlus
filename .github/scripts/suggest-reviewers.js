// .github/scripts/suggest-reviewers.js
const { achrev_suggestion } = require('./recommenders/AcHRev');

const { 
  calculateWorkloadAnalytics, 
  getPRPerformanceMetrics, 
  getLastActivityDatesForPRFiles 
} = require('./workload-analytics');
const { createClient } = require('@supabase/supabase-js');
const core = require('@actions/core');
const github = require('@actions/github');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function suggestReviewers() {
  console.log('🔍 Analyzing PR for detailed reviewer suggestions...');
  
  try {
    const context = github.context;
    const pr = context.payload.pull_request;
    
    if (!pr) {
      throw new Error('No pull request found in context');
    }
    
    // Get GitHub token (should be available from environment)
    const token = process.env.GITHUB_TOKEN;
    
    if (!token) {
      throw new Error('GitHub token not available');
    }
    
    console.log(`✅ GitHub token found: ${token.substring(0, 4)}... (${token.length} chars)`);
    
    // Create Octokit instance
    console.log('🧪 Creating Octokit client...');
    const octokit = github.getOctokit(token);
    
    // Get PR files from GitHub API
    const { data: prFiles } = await octokit.rest.pulls.listFiles({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number
    });
    
    console.log(`📁 Found ${prFiles.length} files in PR`);
    
    // Analyze files in detail
    const fileAnalysis = await analyzeFiles(prFiles, pr.user.login, pr.created_at);
    
    // Calculate detailed reviewer metrics
    const reviewerMetrics = await calculateDetailedReviewerMetrics(prFiles, pr.user.login);
    
    // Generate comprehensive comment
    const comment = generateDetailedComment(fileAnalysis, reviewerMetrics, pr.user.login, prFiles);
    
    // Post comment
    await octokit.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: pr.number,
      body: comment
    });
    
    console.log('✅ Detailed reviewer suggestions posted successfully!');
    
  } catch (error) {
    console.error('❌ Error suggesting reviewers:', error);
    core.setFailed(error.message);
  }
}

async function analyzeFiles(prFiles, prAuthor, prCreatedAt) {
  console.log('📊 Analyzing PR files & Author Knowledge...');

  const fileAnalysis = [];

  for (const prFile of prFiles) {
    const filePath = prFile.filename;
    const changeType = getChangeType(prFile);

    // Use GitHub API fields if available: total changed lines
    const changeSize = typeof prFile.changes === 'number'
      ? prFile.changes
      : ( (typeof prFile.additions === 'number' && typeof prFile.deletions === 'number')
          ? prFile.additions + prFile.deletions
          : null );

    // 1) Get contributions on this file by OTHER developers (prior to PR creation date)
    const { data: fileContributions } = await supabase
      .from('contributions')
      .select(`
        contributor_id,
        activity_type,
        contribution_date,
        contributors!inner(github_login, canonical_name),
        files!inner(current_path, canonical_path)
      `)
      .or(`files.current_path.eq.${filePath},files.canonical_path.eq.${filePath}`)
      .lt('contribution_date', prCreatedAt) // only _prior_ contributions
      .neq('contributors.github_login', prAuthor); // exclude PR author for NumKnowledgable

    // Count unique other developers who have prior commits/reviews on this file
    const uniqueDevs = new Set();
    if (fileContributions) {
      fileContributions.forEach(contrib => {
        const login = contrib.contributors.github_login;
        if (login) uniqueDevs.add(login);
      });
    }
    const numKnowledgable = uniqueDevs.size;

    // 2) Get contributions on this file BY THE AUTHOR (prior to PR creation date)
    const { data: authorContributions } = await supabase
      .from('contributions')
      .select(`
        activity_type,
        contribution_date,
        lines_modified,
        contributors!inner(github_login),
        files!inner(current_path)
      `)
      .or(`files.current_path.eq.${filePath},files.canonical_path.eq.${filePath}`)
      .lt('contribution_date', prCreatedAt)
      .eq('contributors.github_login', prAuthor);

    // Aggregate author stats for this file
    let authorNumCommits = 0;
    let authorNumReviews = 0;
    let authorLastCommitDate = null;
    let authorLastReviewDate = null;

    if (authorContributions) {
      authorContributions.forEach(ac => {
        const dt = ac.contribution_date ? new Date(ac.contribution_date) : null;
        if (ac.activity_type === 'commit') {
          authorNumCommits++;
          if (dt && (!authorLastCommitDate || dt > authorLastCommitDate)) {
            authorLastCommitDate = dt;
          }
        } else if (ac.activity_type === 'review') {
          authorNumReviews++;
          if (dt && (!authorLastReviewDate || dt > authorLastReviewDate)) {
            authorLastReviewDate = dt;
          }
        }
      });
    }

    // Format dates to ISO strings for later formatting (or null)
    authorLastCommitDate = authorLastCommitDate ? authorLastCommitDate.toISOString() : null;
    authorLastReviewDate = authorLastReviewDate ? authorLastReviewDate.toISOString() : null;

    // NOTE: per-file author CxFactor isn't available in current achrev call (we return null for now)
    const authorCxFactor = null;

    // Keep topContributor if you still want it internally (not printed in the new table),
    // but we keep it for potential later use.
    // Re-query for other-dev contribution breakdown if you want top contributor info.
    let topContributor = null;
    // (optional) compute topContributor among the other devs if needed:
    if (fileContributions && fileContributions.length > 0) {
      const commits = new Map();
      const reviews = new Map();
      fileContributions.forEach(c => {
        const login = c.contributors.github_login;
        if (!login) return;
        if (c.activity_type === 'commit') commits.set(login, (commits.get(login)||0)+1);
        if (c.activity_type === 'review') reviews.set(login, (reviews.get(login)||0)+1);
      });
      // pick top by commits+reviews
      let best = null, bestCount = -1;
      commits.forEach((cCount, login) => {
        const rCount = reviews.get(login) || 0;
        const tot = cCount + rCount;
        if (tot > bestCount) {
          bestCount = tot;
          best = { login, commits: cCount, reviews: rCount, total: tot };
        }
      });
      if (best) topContributor = best;
    }

    fileAnalysis.push({
      filename: filePath,
      changeType,
      numKnowledgable,           // new: number of other developers with prior history
      changeSize,                // new: lines changed in the PR for this file
      authorNumCommits,          // new: number of PR-author prior commits on this file
      authorLastCommitDate,      // new: ISO date or null
      authorNumReviews,          // new: number of times author reviewed this file before PR
      authorLastReviewDate,      // new: ISO date or null
      authorCxFactor,            // null for now (see note below)
      topContributor,
      isNew: changeType === 'create'
    });
  }

  return fileAnalysis;
}

async function calculateDetailedReviewerMetrics(prFiles, prAuthor) {
  console.log('📈 Calculating detailed reviewer metrics...');
  
  const filePaths = prFiles.map(f => f.filename);
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  
  // Get all contributions for PR files
  const { data: prFileContributions } = await supabase
    .from('contributions')
    .select(`
      contributor_id,
      activity_type,
      contribution_date,
      lines_modified,
      contributors!inner(github_login, canonical_name),
      files!inner(current_path)
    `)
    .in('files.current_path', filePaths)
    .neq('contributors.github_login', prAuthor);
  
  // Get global contributions for the last year
  const { data: globalContributions } = await supabase
    .from('contributions')
    .select(`
      contributor_id,
      activity_type,
      contribution_date,
      lines_modified,
      contributors!inner(github_login, canonical_name)
    `)
    .gte('contribution_date', oneYearAgo.toISOString())
    .neq('contributors.github_login', prAuthor);
  
  // Process metrics by contributor
  const contributorMetrics = new Map();
  
  // Process PR file knowledge
  if (prFileContributions) {
    prFileContributions.forEach(contrib => {
      const login = contrib.contributors.github_login;
      const filePath = contrib.files.current_path;
      
      if (!contributorMetrics.has(login)) {
        contributorMetrics.set(login, {
          login,
          canonical_name: contrib.contributors.canonical_name,
          knownFiles: new Set(),
          localCommits: 0,
          localReviews: 0,
          globalCommits: 0,
          globalReviews: 0,
          activeMonths: new Set()
        });
      }
      
      const metrics = contributorMetrics.get(login);
      metrics.knownFiles.add(filePath);
      
      if (contrib.activity_type === 'commit') {
        metrics.localCommits++;
      } else if (contrib.activity_type === 'review') {
        metrics.localReviews++;
      }
    });
  }
  
  // Process global activity
  if (globalContributions) {
    globalContributions.forEach(contrib => {
      const login = contrib.contributors.github_login;
      const date = new Date(contrib.contribution_date);
      const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
      
      if (!contributorMetrics.has(login)) {
        contributorMetrics.set(login, {
          login,
          canonical_name: contrib.contributors.canonical_name,
          knownFiles: new Set(),
          localCommits: 0,
          localReviews: 0,
          globalCommits: 0,
          globalReviews: 0,
          activeMonths: new Set()
        });
      }
      
      const metrics = contributorMetrics.get(login);
      metrics.activeMonths.add(monthKey);
      
      if (contrib.activity_type === 'commit') {
        metrics.globalCommits++;
      } else if (contrib.activity_type === 'review') {
        metrics.globalReviews++;
      }
    });
  }
  
  // Convert to final metrics array
  const finalMetrics = Array.from(contributorMetrics.values()).map(metrics => ({
    login: metrics.login,
    canonical_name: metrics.canonical_name,
    knows: metrics.knownFiles.size,
    learns: filePaths.length - metrics.knownFiles.size, // NEW: Calculate learns
    lCommits: metrics.localCommits,
    lReviews: metrics.localReviews,
    gCommits: metrics.globalCommits,
    gReviews: metrics.globalReviews,
    aMonths: metrics.activeMonths.size,
    knownFilesList: Array.from(metrics.knownFiles)
  }));
  
  // Calculate workload analytics
  console.log('📊 Calculating workload analytics...');
  const workloadData = await calculateWorkloadAnalytics(finalMetrics);
  
  // Get PR performance metrics
  console.log('⏱️ Calculating PR performance metrics...');
  const contributorLogins = finalMetrics.map(m => m.login);
  const performanceData = await getPRPerformanceMetrics(contributorLogins);
  
  // Get last activity dates for PR files
  console.log('📅 Getting last activity dates...');
  const activityData = await getLastActivityDatesForPRFiles(contributorLogins, filePaths);

  // Add CxFactor scoring
  console.log('🎯 Calculating CxFactor scores...');
  const expertScores = await achrev_suggestion(
    github.context.payload.pull_request.number,
    prAuthor,
    prFiles,
    20 // Get top 20 for comprehensive analysis
  );

  // Create a map for easy lookup
  const expertScoreMap = new Map();
  if (Array.isArray(expertScores)) {
    expertScores.forEach(expert => {
      // normalize expected fields and guard against missing props
      const login = expert.login || expert.github || expert.handle;
      const cxFactorScore = typeof expert.cxFactorScore === 'number' ? expert.cxFactorScore : (expert.score || 0);
      const fileCount = typeof expert.fileCount === 'number' ? expert.fileCount : (expert.files || 0);
      if (login) {
        expertScoreMap.set(login, { cxFactorScore, fileCount });
      }
    });
  }
  
  // Combine all metrics (including CxFactor)
  const enhancedMetrics = finalMetrics.map(metrics => {
    const workload = workloadData.get(metrics.login) || {};
    const performance = performanceData.get(metrics.login) || {};
    const activity = activityData.get(metrics.login) || {};
    const expertScore = expertScoreMap.get(metrics.login) || { cxFactorScore: 0, fileCount: 0 };
    
    return {
      ...metrics,
      // Workload metrics
      workloadShare: workload.workloadShare || 0,
      percentileRank: workload.percentileRank || 0,
      relativeToMean: workload.relativeToMean || 0,
      giniWorkload: workload.giniWorkload || 0,
      // Performance metrics
      avgReviewTimeHours: performance.avgReviewTimeHours || 0,
      avgReviewSizeLines: performance.avgReviewSizeLines || 0,
      linesPerHour: performance.linesPerHour || 0,
      lastReviewDate: performance.lastReviewDate,
      lastReviewInPRFiles: activity.lastReviewInPRFiles,
      lastCommitDate: activity.lastCommitDate,
      lastModificationInPRFiles: activity.lastModificationInPRFiles,
      // CxFactor score
      cxFactorScore: expertScore.cxFactorScore,
      expertFileCount: expertScore.fileCount
    };
  });
  
  // Sort by knowledge (knows) first, then by total local activity (original sorting)
  enhancedMetrics.sort((a, b) => {
    if (b.knows !== a.knows) {
      return b.knows - a.knows;
    }
    return (b.lCommits + b.lReviews) - (a.lCommits + a.lReviews);
  });
  
  return enhancedMetrics.slice(0, 10); // Top 10 candidates
}

function getChangeType(prFile) {
  if (prFile.status === 'added') return 'create';
  if (prFile.status === 'removed') return 'delete';
  if (prFile.status === 'modified') return 'modify';
  if (prFile.status === 'renamed') return 'rename';
  return 'modify'; // default
}

function generateDetailedComment(fileAnalysis, reviewerMetrics, prAuthor, prFiles) {
  const filePaths = prFiles.map(f => f.filename);
  let comment = `## 📊 Pull Request Analysis

### 📁 Files Modified in this PR

### Author Knowledge: @${prAuthor}

| File | Change Type | NumKnowledgable | Change Size | NumCommit | Last Commit Date | NumReview | Last Review Date | Author CxFactor |
|------|-------------|-----------------|-------------|-----------|------------------|-----------|------------------|-----------------|
`;

  // Categorize files
  const abandonedFiles = [];
  const hoardedFiles = [];

  fileAnalysis.forEach(file => {
    // Format author dates
    const formatDate = (iso) => {
      if (!iso) return 'N/A';
      const d = new Date(iso);
      return isNaN(d) ? 'N/A' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    };

    const changeSizeText = (typeof file.changeSize === 'number') ? file.changeSize : 'N/A';
    const cxText = (file.authorCxFactor === null || file.authorCxFactor === undefined) ? 'N/A' : file.authorCxFactor.toFixed(3);

    comment += `| \`${file.filename}\` | ${file.changeType} | ${file.numKnowledgable} | ${changeSizeText} | ${file.authorNumCommits} | ${formatDate(file.authorLastCommitDate)} | ${file.authorNumReviews} | ${formatDate(file.authorLastReviewDate)} | ${cxText} |\n`;

    // Categorize files (abandoned/hoarded logic: keep using numKnowledgable)
    if (file.numKnowledgable === 0) {
      abandonedFiles.push(file.filename);
    } else if (file.numKnowledgable === 1 && file.topContributor) {
      hoardedFiles.push({
        filename: file.filename,
        owner: file.topContributor.login
      });
    }
  });

  comment += `
  
  **Column descriptions:**
  - **NumKnowledgable**: Number of other developers (excluding PR author) who have prior commits or reviews on this file _before_ the PR creation date.
  - **Change Size**: Total lines changed in this PR for the file (additions + deletions / GitHub 'changes' field).
  - **NumCommit**: Number of earlier commits made by the PR author on this file (excluding the current PR commits).
  - **Last Commit Date**: Date of the author's most recent prior commit on this file.
  - **NumReview**: Number of times the PR author acted as a reviewer on this file prior to this PR.
  - **Last Review Date**: Date of the author's most recent prior review activity on this file.
  - **Author CxFactor**: Author's CxFactor **for this file** (N/A unless the achrev/ACHRev call is extended to return per-file CxFactor — see note).
  `;
  
  // Add enhanced reviewer suggestions with LEARNS column
  if (reviewerMetrics.length === 0) {
    comment += `\n### 👥 Reviewer Suggestions

No developers found with prior experience on these files. Consider assigning reviewers based on:
- Team responsibilities
- Code architecture knowledge
- Subject matter expertise`;
  } else {
    comment += `\n### 👥 Reviewer Candidates

| Developer | Knows | Learns | WorkloadShare% | PercentileRank% | Relative To Mean% | ΔGiniWorkload(Absolute) | AvgTime(h) | AvgSize(line) | line/hour | LastReview | LastReviewOnPRFile |
|-----------|-------|--------|----------------|-----------------|-------------------|-------------------------|------------|---------------|-----------|------------|--------------------|
`;

    // helpers
    const formatDate = (dateStr) => {
      const d = new Date(dateStr);
      return dateStr && !isNaN(d)
        ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'N/A';
    };

    const formatNumber = (num, decimals = 1) =>
      typeof num === 'number' && !isNaN(num) ? num.toFixed(decimals) : '0.0';

    reviewerMetrics.forEach(metrics => {
      comment += `| @${metrics.login} | ${metrics.knows} | ${metrics.learns} | ${formatNumber(metrics.workloadShare)} | ${formatNumber(metrics.percentileRank)} | ${formatNumber(metrics.relativeToMean)} | ${formatNumber(metrics.giniWorkload)} | ${formatNumber(metrics.avgReviewTimeHours)} | ${Math.round(metrics.avgReviewSizeLines)} | ${formatNumber(metrics.linesPerHour)} | ${formatDate(metrics.lastReviewDate)} | ${formatDate(metrics.lastReviewInPRFiles)} |\n`;
    });

    comment += `\n**Legend:**
- **Knows**: Files in this PR the reviewer has worked on before  
- **Learns**: Files in this PR new to the reviewer (${filePaths.length} total - Knows)  
- **WorkloadShare%**: Percentage of total reviews in the last quarter  
- **PercentileRank%**: Position in team workload distribution  
- **Relative To Mean%**: Deviation from the team average workload  
- **ΔGiniWorkload(Absolute)**: Gini coefficient of workload inequality  
- **AvgTime(h)**: Average review time in hours  
- **AvgSize(line)**: Average diff size in lines  
- **line/hour**: Lines reviewed per hour  
- **LastReview**: Date of last review activity  
- **LastReviewOnPRFile**: Date of last review on any file in this PR  
`;

    const cxFactorScores = reviewerMetrics
      .filter(m => m.cxFactorScore > 0)
      .sort((a, b) => b.cxFactorScore - a.cxFactorScore);

    if (cxFactorScores.length > 0) {
      comment += `\n### 🎯 CxFactor Expertise Scores

| Developer | CxFactor Score |
|-----------|----------------|
`;

      cxFactorScores.forEach(metrics => {
        comment += `| @${metrics.login} | ${(metrics.cxFactorScore || 0).toFixed(3)} |\n`;
      });

      comment += `\n**CxFactor Score**: ACHRev expertise score (0-1) based on review history, commit history, work patterns, and recency of contributions on PR files.
`;
    }

    // Additional metrics section
    comment += `<details>
<summary>📊 Additional Metrics & Activity Timeline</summary>

### Activity Timeline
| Developer | LastCommit | LastModPR | L-Commits | L-Reviews | G-Commits | G-Reviews | A-Months |
|-----------|------------|-----------|-----------|-----------|-----------|-----------|----------|
`;

    reviewerMetrics.forEach(metrics => {
      comment += `| @${metrics.login} | ${formatDate(metrics.lastCommitDate)} | ${formatDate(metrics.lastModificationInPRFiles)} | ${metrics.lCommits} | ${metrics.lReviews} | ${metrics.gCommits} | ${metrics.gReviews} | ${metrics.aMonths} |\n`;
    });

    comment += `\n**Timeline Legend:**
- **LastCommit**: Date of last commit (any file, all time)
- **LastModPR**: Date of last modification in any of this PR's files (all time)
- **L-Commits**: Local commits on known files (all time)
- **L-Reviews**: Local reviews on known files (all time)
- **G-Commits**: Global commits in the last year
- **G-Reviews**: Global reviews in the last year
- **A-Months**: Active months in the last year

`;
    
// ### File Knowledge Breakdown
//     reviewerMetrics.forEach(metrics => {
//       if (metrics.knownFilesList.length > 0) {
//         comment += `**@${metrics.login}** knows these files:\n`;
//         metrics.knownFilesList.forEach(file => {
//           comment += `- \`${file}\`\n`;
//         });
//         comment += '\n';
//       }
//     });
    
    comment += `</details>`;
  }
  
  comment += `\n---
*This enhanced analysis includes workload distribution metrics and performance indicators from the last quarter (3 months). Workload metrics help ensure fair distribution of review responsibilities across the team.*

*Generated for PR by @${prAuthor}*`;
  
  return comment;
}

// Run if called directly
if (require.main === module) {
  suggestReviewers();
}

module.exports = { suggestReviewers };
