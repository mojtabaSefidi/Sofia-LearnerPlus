const { createClient } = require('@supabase/supabase-js');
const core = require('@actions/core');
const github = require('@actions/github');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function achrev_suggestion(prNumber, prAuthor, prFiles, topN = 5) {
  console.log('🔬 Running achrev_suggestion...');
  if (!prFiles || prFiles.length === 0) {
    return [];
  }

  const filePaths = prFiles.map(f => f.filename);

  // Get review comments data
  const { data: reviewRows, error: reviewErr } = await supabase
    .from('contributions')
    .select(`
      contributor_id,
      contribution_date,
      contributors!inner(github_login, canonical_name),
      files!inner(current_path, canonical_path)
    `)
    .in('files.current_path', filePaths)
    .eq('activity_type', 'review')
    .neq('contributors.github_login', prAuthor);

  if (reviewErr) {
    console.error('Error fetching review contributions:', reviewErr);
    throw reviewErr;
  }

  // Get commit data
  const { data: commitRows, error: commitErr } = await supabase
    .from('contributions')
    .select(`
      contributor_id,
      contribution_date,
      contributors!inner(github_login, canonical_name),
      files!inner(current_path, canonical_path)
    `)
    .in('files.current_path', filePaths)
    .eq('activity_type', 'commit')
    .neq('contributors.github_login', prAuthor);

  if (commitErr) {
    console.error('Error fetching commit contributions:', commitErr);
    throw commitErr;
  }

  const fileTotals = new Map();
  const devFileStats = new Map();

  function ensureFileTotals(path) {
    if (!fileTotals.has(path)) {
      fileTotals.set(path, {
        R_f_prime: 0,          // Total reviews on file
        W_f_prime: new Set(),  // Total work days for reviews
        T_r_f_prime: null,     // Most recent review date
        C_f_prime: 0,          // Total commits on file  
        T_c_f_prime: null      // Most recent commit date
      });
    }
  }

  function ensureDevFileStats(path, login, canonical_name) {
    const key = `${path}:${login}`;
    if (!devFileStats.has(key)) {
      devFileStats.set(key, {
        path,
        login,
        canonical_name,
        R_f: 0,                // Developer's reviews on file
        W_f: new Set(),        // Developer's work days for reviews
        T_r_f: null,           // Developer's most recent review date
        C_f: 0,                // Developer's commits on file
        T_c_f: null            // Developer's most recent commit date
      });
    }
    return devFileStats.get(key);
  }

  // Process review data
  if (reviewRows && Array.isArray(reviewRows)) {
    reviewRows.forEach(r => {
      const path = r.files.current_path;
      const login = r.contributors.github_login;
      const cname = r.contributors.canonical_name;
      const date = r.contribution_date ? new Date(r.contribution_date) : null;

      ensureFileTotals(path);
      const ft = fileTotals.get(path);
      ft.R_f_prime += 1;
      if (date) {
        const dateStr = date.toISOString().slice(0, 10);
        ft.W_f_prime.add(dateStr);
        if (!ft.T_r_f_prime || date > ft.T_r_f_prime) {
          ft.T_r_f_prime = date;
        }
      }

      const dev = ensureDevFileStats(path, login, cname);
      dev.R_f += 1;
      if (date) {
        const dateStr = date.toISOString().slice(0, 10);
        dev.W_f.add(dateStr);
        if (!dev.T_r_f || date > dev.T_r_f) {
          dev.T_r_f = date;
        }
      }
    });
  }

  // Process commit data
  if (commitRows && Array.isArray(commitRows)) {
    commitRows.forEach(c => {
      const path = c.files.current_path;
      const login = c.contributors.github_login;
      const cname = c.contributors.canonical_name;
      const date = c.contribution_date ? new Date(c.contribution_date) : null;

      ensureFileTotals(path);
      const ft = fileTotals.get(path);
      ft.C_f_prime += 1;
      if (date) {
        if (!ft.T_c_f_prime || date > ft.T_c_f_prime) {
          ft.T_c_f_prime = date;
        }
      }

      const dev = ensureDevFileStats(path, login, cname);
      dev.C_f += 1;
      if (date) {
        if (!dev.T_c_f || date > dev.T_c_f) {
          dev.T_c_f = date;
        }
      }
    });
  }

  // Ensure all files are initialized
  for (const path of filePaths) {
    ensureFileTotals(path);
  }

  // Calculate CxFactor scores
  const devAggregate = new Map();

  function calculateRecencyScore(devDate, fileDate) {
    if (!fileDate || !devDate) return 0.0;
    if (devDate.getTime() === fileDate.getTime()) return 1.0;
    
    const daysDiff = Math.abs((devDate - fileDate) / (1000 * 60 * 60 * 24));
    return 1.0 / (1.0 + daysDiff);
  }

  for (const [key, dev] of devFileStats) {
    const ft = fileTotals.get(dev.path);
    
    // Calculate the 5 components of CxFactor
    const scoreReviewComments = ft.R_f_prime === 0 ? 0.0 : dev.R_f / ft.R_f_prime;
    const scoreWorkDays = ft.W_f_prime.size === 0 ? 0.0 : dev.W_f.size / ft.W_f_prime.size;
    const scoreReviewRecency = calculateRecencyScore(dev.T_r_f, ft.T_r_f_prime);
    const scoreCommits = ft.C_f_prime === 0 ? 0.0 : dev.C_f / ft.C_f_prime;
    const scoreCommitRecency = calculateRecencyScore(dev.T_c_f, ft.T_c_f_prime);
    
    const fileScore = scoreReviewComments + scoreWorkDays + scoreReviewRecency + scoreCommits + scoreCommitRecency;

    if (!devAggregate.has(dev.login)) {
      devAggregate.set(dev.login, {
        login: dev.login,
        canonical_name: dev.canonical_name,
        totalScore: 0,
        fileCount: 0,
        perFile: []
      });
    }

    const agg = devAggregate.get(dev.login);
    agg.totalScore += fileScore;
    agg.fileCount += 1;
    agg.perFile.push({
      file: dev.path,
      scoreReviewComments,
      scoreWorkDays,
      scoreReviewRecency,
      scoreCommits,
      scoreCommitRecency,
      fileScore
    });
  }

  const results = [];
  for (const [login, agg] of devAggregate) {
    // Normalize score to 0-1 range by dividing by total possible score (5 points per file)
    const normalizedScore = agg.fileCount > 0 ? agg.totalScore / (5 * agg.fileCount) : 0;
    
    results.push({
      login,
      canonical_name: agg.canonical_name,
      cxFactorScore: normalizedScore,
      fileCount: agg.fileCount,
      perFile: agg.perFile
    });
  }

  results.sort((a, b) => b.cxFactorScore - a.cxFactorScore);

  return results.slice(0, topN);
}

module.exports.achrev_suggestion = achrev_suggestion;
