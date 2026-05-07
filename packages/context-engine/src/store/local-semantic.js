const EMBEDDING_MODEL_ID = 'viewport-local-hash-embed-v0';
const EMBEDDING_MODEL_DIGEST = 'sha256:local-hash-embed-v0';

const SYNONYMS = new Map([
  ['auth', ['authentication', 'login', 'session', 'sessions']],
  ['authentication', ['auth', 'login', 'session', 'sessions']],
  ['regression', ['proof', 'test', 'tests', 'coverage']],
  ['proof', ['regression', 'test', 'tests', 'evidence']],
  ['decision', ['standard', 'rule', 'architecture', 'choice']],
  ['decisions', ['standard', 'rule', 'architecture', 'choice']],
  ['deploy', ['deployment', 'release', 'ship']],
  ['deployment', ['deploy', 'release', 'ship']],
  ['review', ['pr', 'pull', 'request', 'approval']],
  ['pr', ['review', 'pull', 'request']],
]);

function tokenize(value) {
  return String(value)
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
}

function vectorize(value) {
  const vector = new Map();
  for (const token of tokenize(value)) {
    vector.set(token, (vector.get(token) ?? 0) + 1);
    for (const synonym of SYNONYMS.get(token) ?? []) {
      vector.set(synonym, (vector.get(synonym) ?? 0) + 0.35);
    }
  }
  return vector;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let aMag = 0;
  let bMag = 0;

  for (const value of a.values()) {
    aMag += value * value;
  }

  for (const [key, value] of b) {
    bMag += value * value;
    dot += (a.get(key) ?? 0) * value;
  }

  if (aMag === 0 || bMag === 0) {
    return 0;
  }

  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}

function rankEntries(entries, query) {
  const queryVector = vectorize(query);
  return entries
    .map((entry) => ({
      entry,
      score: cosineSimilarity(queryVector, vectorize(`${entry.title}\n${entry.body}\n${entry.source}`)),
    }))
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
}

module.exports = {
  EMBEDDING_MODEL_DIGEST,
  EMBEDDING_MODEL_ID,
  rankEntries,
};
