/**
 * location-core.mjs — shared location reasoning for scan.mjs and scan-boards.mjs.
 *
 * Both scanners run the same strict-allowlist rule and had the same bug, so the
 * rule lives here once.
 */

// Words that describe *how* or *roughly where* you work rather than naming a
// place. "Office", "onsite" and "hybrid" used to count as ambiguity, which meant
// "Manchester Office" was treated as an unknown location and kept — that is how
// UK and other foreign postings entered a Germany-only pipeline.
const VAGUE = /\b(remote|hybrid|onsite|on-?site|offices?|hq|headquarters?|europe|european|emea|eu|dach|global|worldwide|international|anywhere|multiple|various|several|different|flexible|based|area|region|regional|location|locations|site|sites|other|home|work)\b/g;

// Left-over connective tissue that is not a place name.
const CONNECTORS = new Set([
  'and', 'the', 'for', 'our', 'all', 'any', 'within', 'across', 'from', 'near',
  'also', 'plus', 'only', 'etc', 'inc', 'ltd', 'gmbh', 'new', 'city', 'town',
  'per', 'via', 'with', 'more', 'one', 'two', 'des', 'der', 'die', 'das', 'und',
]);

/**
 * True when the string still names a concrete place after the vague modifiers
 * are stripped out — i.e. it is a real location that simply did not match the
 * allowlist, and should therefore be dropped.
 *
 * Returns false for genuinely unknowable strings ("Remote", "EMEA", "Multiple
 * locations"), which are kept so the evaluator can judge them.
 */
export function namesAPlace(location) {
  if (!location) return false;
  const residue = location
    .toLowerCase()
    .replace(VAGUE, ' ')
    .split(/[^a-zà-ÿ]+/i)
    .filter((w) => w.length >= 3 && !CONNECTORS.has(w));
  return residue.length > 0;
}

export { VAGUE, CONNECTORS };
