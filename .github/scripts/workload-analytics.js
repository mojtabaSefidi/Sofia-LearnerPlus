// .github/scripts/workload-analytics.js
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/**
 * Calculate workload analytics for the last quarter
 */
async function calculateWorkloadAnalytics(contributors) {
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  // Get quarterly review data
  const { data: quarterlyReviews } = await supabase
    .from('contributions')
    .select(`
      contributor_id,
      contributors!inner(github_login),
      lines_modified
    `)
    .eq('activity_type', 'review')
    .gte('contribution_date', threeMonthsAgo.toISOString());

  // Calculate workload metrics
  const workloadData = new Map();
  let totalReviews = 0;
  let totalLinesReviewed = 0;

  // Initialize data for all contributors
  contributors.forEach(contributor => {
    workloadData.set(contributor.login, {
      reviews: 0,
      linesReviewed: 0,
      workloadShare: 0,
      percentileRank: 0,
      relativeToMean: 0,
      giniWorkload: 0
    });
  });

  // Process quarterly reviews
  if (quarterlyReviews) {
    quarterlyReviews.forEach(review => {
      const login = review.contributors.github_login;
      const lines = review.lines_modified || 0;
      
      if (workloadData.has(login)) {
        const data = workloadData.get(login);
        data.reviews += 1;
        data.linesReviewed += lines;
        totalReviews += 1;
        totalLinesReviewed += lines;
      }
    });
  }

  // Calculate workload metrics
  const reviewCounts = Array.from(workloadData.values()).map(d => d.reviews);
  const meanReviews = totalReviews / contributors.length;

  // Calculate Gini coefficient for workload distribution
  const giniCoefficient = calculateGiniCoefficient(reviewCounts);

  // Update metrics for each contributor
  workloadData.forEach((data, login) => {
    // Workload Share
    data.workloadShare = totalReviews > 0 ? (data.reviews / totalReviews) * 100 : 0;

    // Percentile Rank
    const rank = reviewCounts.filter(count => count < data.reviews).length;
    data.percentileRank = contributors.length > 1 ? (rank / (contributors.length - 1)) * 100 : 0;

    // Relative To Mean
    data.relativeToMean = meanReviews > 0 ? ((data.reviews - meanReviews) / meanReviews) * 100 : 0;

    // Gini Workload (absolute value)
    data.giniWorkload = Math.abs(giniCoefficient * 100);
  });

  return workloadData;
}

/**
 * Calculate Gini coefficient for workload distribution
 */
function calculateGiniCoefficient(values) {
  if (values.length === 0) return 0;
  
  const sortedValues = values.slice().sort((a, b) => a - b);
  const n = sortedValues.length;
  const sum = sortedValues.reduce((acc, val) => acc + val, 0);
  
  if (sum === 0) return 0;
  
  let numerator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (2 * (i + 1) - n - 1) * sortedValues[i];
  }
  
  return numerator / (n * sum);
}

/**
 * Get PR performance metrics for contributors
 */
async function getPRPerformanceMetrics(contributorLogins) {
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  // Get PR review performance data
  const { data: prMetrics } = await supabase
    .from('pr_performance_metrics')
    .select('*')
    .in('reviewer_login', contributorLogins);

  // Get last review dates for specific files
  const performanceData = new Map();

  for (const login of contributorLogins) {
    const metrics = prMetrics?.find(m => m.reviewer_login === login) || {};
    
    performanceData.set(login, {
      avgReviewTimeHours: metrics.avg_review_time_hours || 0,
      avgReviewSizeLines: metrics.avg_review_size_lines || 0,
      linesPerHour: metrics.lines_per_hour || 0,
      lastReviewDate: metrics.last_review_activity || null,
      lastReviewInPRFiles: null, // Will be calculated separately
      lastCommitDate: null,
      lastModificationInPRFiles: null
    });
  }

  return performanceData;
}

/**
 * Get last activity dates for PR files
 */
async function getLastActivityDatesForPRFiles(contributorLogins, prFilePaths) {
  const activityData = new Map();

  for (const login of contributorLogins) {
    // Get last review date in PR files
    const { data: lastReviewInFiles } = await supabase
      .from('contributions')
      .select(`
        contribution_date,
        contributors!inner(github_login),
        files!inner(current_path)
      `)
      .eq('activity_type', 'review')
      .in('files.current_path', prFilePaths)
      .eq('contributors.github_login', login)
      .order('contribution_date', { ascending: false })
      .limit(1);

    // Get last commit date (ALL TIME - removed date filter)
    const { data: lastCommit } = await supabase
      .from('contributions')
      .select(`
        contribution_date,
        contributors!inner(github_login)
      `)
      .eq('activity_type', 'commit')
      .eq('contributors.github_login', login)
      .order('contribution_date', { ascending: false })
      .limit(1);

    // Get last modification in PR files (ALL TIME - removed date filter)
    const { data: lastModificationInFiles } = await supabase
      .from('contributions')
      .select(`
        contribution_date,
        contributors!inner(github_login),
        files!inner(current_path)
      `)
      .in('files.current_path', prFilePaths)
      .eq('contributors.github_login', login)
      .order('contribution_date', { ascending: false })
      .limit(1);

    activityData.set(login, {
      lastReviewInPRFiles: lastReviewInFiles?.[0]?.contribution_date || null,
      lastCommitDate: lastCommit?.[0]?.contribution_date || null,
      lastModificationInPRFiles: lastModificationInFiles?.[0]?.contribution_date || null
    });
  }

  return activityData;
}

module.exports = {
  calculateWorkloadAnalytics,
  getPRPerformanceMetrics,
  getLastActivityDatesForPRFiles
};
