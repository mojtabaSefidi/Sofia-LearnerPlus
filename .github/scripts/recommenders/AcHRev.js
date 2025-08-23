const { createClient } = require('@supabase/supabase-js');
const core = require('@actions/core');
const github = require('@actions/github');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function achrev_suggestion(prNumber, prAuthor, prFiles, topN = 5, prCreatedAt = null, options = {}) {
  console.log('🔬 Running achrev_suggestion...');

  if (!prFiles || prFiles.length === 0) {
    return [];
  }

  options = {
    includeAuthor: true,
    perFileForAuthorOnly: true,
    ...options
  };

  const filePaths = prFiles.map(f => f.filename);

  // Build review query (include author if options.includeAuthor)
  let reviewQuery = supabase
    .from('contributions')
    .select(`
      contributor_id,
      contribution_date,
      contributors!inner(github_login, canonical_name),
      files!inner(current_path, canonical_path),
      activity_type
    `)
    .in('files.current_path', filePaths)
    .eq('activity_type', 'review');

  if (prCreatedAt) reviewQuery = reviewQuery.lt('contribution_date', prCreatedAt);

  const { data: reviewRows, error: reviewErr } = await reviewQuery;
  if (reviewErr) {
    console.error('Error fetching review contributions:', reviewErr);
    throw reviewErr;
  }

  // Build commit query (include author if options.includeAuthor)
  let commitQuery = supabase
    .from('contributions')
    .select(`
      contributor_id,
      contribution_date,
      contributors!inner(github_login, canonical_name),
      files!inner(current_path, canonical_path),
      activity_type
    `)
    .in('files.current_path', filePaths)
    .eq('activity_type', 'commit');

  if (prCreatedAt) commitQuery = commitQuery.lt('contribution_date', prCreatedAt);

  const { data: commitRows, error: commitErr } = await commitQuery;
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
        W_f_prime: new Set(),  // Distinct work days for reviews (dates)
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
        W_f: new Set(),        // Developer's distinct review days
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

  // Ensure all files are initialized (even if no rows found)
  for (const path of filePaths) {
    ensureFileTotals(path);
  }

  // Aggregate per-developer stats
  const devAggregate = new Map();

  function calculateRecencyScore(devDate, fileDate) {
    if (!fileDate || !devDate) return 0.0;
    // use absolute day difference
    const daysDiff = Math.abs((devDate - fileDate) / (1000 * 60 * 60 * 24));
    return 1.0 / (1.0 + daysDiff);
  }

  for (const [key, dev] of devFileStats) {
    const ft = fileTotals.get(dev.path);

    // Five components (guard divisions)
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
      fileScore // raw (0..5)
    });
  }

  // Normalize developer-level score by total number of PR files (not by dev fileCount)
  const totalPRFiles = filePaths.length || 1;

  const results = [];
  for (const [login, agg] of devAggregate) {
    // developer-level normalized score in [0..1]
    const normalizedScore = totalPRFiles > 0 ? agg.totalScore / (5 * totalPRFiles) : 0;

    // Only add per-file normalized (0..1) for the author by default to limit work.
    // perFileNormalized = fileScore / 5
    const perFileOutput = agg.perFile.map(p => {
      const out = { ...p };
      if (!options.perFileForAuthorOnly || login === prAuthor) {
        out.normalizedFileCx = (typeof p.fileScore === 'number') ? (p.fileScore / 5) : null;
        // also optionally provide normalized by PR files if caller needs it:
        out.normalizedFileCxByPR = (typeof p.fileScore === 'number') ? (p.fileScore / (5 * totalPRFiles)) : null;
      }
      return out;
    });

    results.push({
      login,
      canonical_name: agg.canonical_name,
      cxFactorScore: normalizedScore,
      fileCount: agg.fileCount,
      perFile: perFileOutput
    });
  }

  // Sort and return topN
  results.sort((a, b) => b.cxFactorScore - a.cxFactorScore);

  return results.slice(0, topN);
}

module.exports.achrev_suggestion = achrev_suggestion;
