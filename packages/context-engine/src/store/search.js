function searchEntries(db, query) {
  const phrase = `"${String(query).replaceAll('"', '""')}"`;
  return db
    .prepare(
      `
      SELECT e.*
      FROM context_entries_fts f
      JOIN context_entries e ON e.id = f.id
      WHERE context_entries_fts MATCH ?
        AND e.superseded_by IS NULL
      ORDER BY rank
    `,
    )
    .all(phrase);
}

function allEntries(db) {
  return db.prepare('SELECT * FROM context_entries ORDER BY created_at, id').all();
}

function allCandidates(db) {
  return db.prepare('SELECT * FROM context_candidates ORDER BY priority_score DESC, created_at, id').all();
}

module.exports = { allCandidates, allEntries, searchEntries };
