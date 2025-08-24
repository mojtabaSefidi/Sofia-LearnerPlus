const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function turnoverRec_suggestion(
  prAuthor,
  prFiles,
  prCreatedAt = null,
  topN = 10,
  C1_turn = 1.0,
  C2_turn = 1.0,
  C1_ret = 1.0,
  C2_ret = 1.0,
  exclude_developer_without_knowledge = false
) {
  console.log('🔬 Running turnoverRec_suggestion...');

  // Validation
  if (!prFiles || !Array.isArray(prFiles) || prFiles.length === 0) {
    return [];
  }
  const filePaths = prFiles.map(f => f.filename);
  const prRefDate = prCreatedAt ? new Date(prCreatedAt) : new Date();
  if (isNaN(prRefDate.getTime())) {
    throw new Error('Invalid prCreatedAt date');
  }

  // Define last-365 window relative to prRefDate (for contribution & consistency)
  const last365Start = new Date(prRefDate.getTime() - 365 * 24 * 60 * 60 * 1000);

  // 1) Fetch candidate list (all contributors excluding author)
  const { data: contributors, error: contribErr } = await supabase
    .from('contributors')
    .select('id, github_login, canonical_name');

  if (contribErr) {
    console.error('Error fetching contributors:', contribErr);
    throw contribErr;
  }

  // Build a map for quick lookups (exclude PR author by login)
  const contributorsMap = new Map();
  for (const c of contributors || []) {
    if (c.github_login && c.github_login.toLowerCase() === String(prAuthor).toLowerCase()) continue;
    contributorsMap.set(c.id, {
      id: c.id,
      login: c.github_login,
      canonical_name: c.canonical_name
    });
  }

  if (contributorsMap.size === 0) {
    return [];
  }

  // 2) Fetch all contributions on PR files that happened BEFORE prRefDate
  let contributionsOnPrFilesQuery = supabase
    .from('contributions')
    .select(`
      contributor_id,
      file_id,
      contribution_date,
      activity_type,
      files!inner(current_path)
    `)
    .in('files.current_path', filePaths)
    .in('activity_type', ['commit', 'review'])
    .lt('contribution_date', prRefDate.toISOString());

  const { data: prsFileRows, error: prFilesErr } = await contributionsOnPrFilesQuery;
  if (prFilesErr) {
    console.error('Error fetching contributions on PR files:', prFilesErr);
    throw prFilesErr;
  }

  // 3) Fetch all contributions in the last 365 days (project-wide) to compute
  //    per-dev counts and months active
  let contributionsLast365Query = supabase
    .from('contributions')
    .select('contributor_id, contribution_date, activity_type')
    .gte('contribution_date', last365Start.toISOString())
    .lte('contribution_date', prRefDate.toISOString())
    .in('activity_type', ['commit', 'review']);

  const { data: last365Rows, error: last365Err } = await contributionsLast365Query;
  if (last365Err) {
    console.error('Error fetching last-365 contributions:', last365Err);
    throw last365Err;
  }

  // 4) Aggregate: num_known_files per candidate (unique file_id) from prsFileRows
  const knownFilesByDev = new Map(); // devId -> Set(file_id)
  for (const r of prsFileRows || []) {
    const devId = r.contributor_id;
    // Only count candidates that exist in contributorsMap (we excluded the author)
    if (!contributorsMap.has(devId)) continue;
    if (!knownFilesByDev.has(devId)) knownFilesByDev.set(devId, new Set());
    knownFilesByDev.get(devId).add(r.file_id);
  }

  // num PR files
  const numPRFiles = filePaths.length;

  // 5) Aggregate: per-dev contribution count and months active from last365Rows
  const contribCountByDev = new Map(); // devId -> count
  const activeMonthsByDev = new Map(); // devId -> Set(monthStr)
  let projectTotalLast365 = 0;

  for (const r of last365Rows || []) {
    const devId = r.contributor_id;
    projectTotalLast365 += 1;

    // per-dev counts
    contribCountByDev.set(devId, (contribCountByDev.get(devId) || 0) + 1);

    // month bucket
    const date = new Date(r.contribution_date);
    if (!isNaN(date.getTime())) {
      const monthStr = date.toISOString().slice(0, 7); // 'YYYY-MM'
      if (!activeMonthsByDev.has(devId)) activeMonthsByDev.set(devId, new Set());
      activeMonthsByDev.get(devId).add(monthStr);
    }
  }

  // 6) Build candidate result list: only contributors that are in contributorsMap and know >=1 file
  const results = [];
  for (const [devId, devMeta] of contributorsMap) {
    const knownSet = knownFilesByDev.get(devId) || new Set();
    const numKnownFiles = knownSet.size;

    // Per the paper: only candidates who know at least one file should be considered.
    if (numKnownFiles <= 0 && exclude_developer_without_knowledge) {
      continue;
    }

    // Knowledge(D,R)
    const knowledge = numPRFiles > 0 ? (numKnownFiles / numPRFiles) : 0.0;
    const learnRec = 1.0 - knowledge;

    // ContributionRatio_365(D)
    const devCnt = contribCountByDev.get(devId) || 0;
    const contributionRatio_365 = projectTotalLast365 > 0 ? (devCnt / projectTotalLast365) : 0.0;

    // ConsistencyRatio_365(D)
    const monthsSet = activeMonthsByDev.get(devId) || new Set();
    const activeMonths = monthsSet.size; // 0..12
    const consistencyRatio_365 = Math.min(activeMonths / 12.0, 1.0);

    // RetentionRec with weights
    const retentionRec = (C1_ret * consistencyRatio_365) * (C2_ret * contributionRatio_365);

    // TurnoverRec with weights
    const turnoverRec = (C1_turn * learnRec) * (C2_turn * retentionRec);

    results.push({
      login: devMeta.login,
      canonical_name: devMeta.canonical_name,
      contributor_id: devId,
      turnoverRec,
      learnRec,
      retentionRec,
      knowledge,
      consistencyRatio_365,
      contributionRatio_365,
      numKnownFiles
    });
  }

  // Sort by turnoverRec descending and return topN
  results.sort((a, b) => b.turnoverRec - a.turnoverRec);
  return results.slice(0, topN);
}

module.exports.turnoverRec_suggestion = turnoverRec_suggestion;
