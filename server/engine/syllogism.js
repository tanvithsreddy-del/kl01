import { FALLACY_EXPLANATIONS } from './logic.js';

const MOODS = ['A', 'E', 'I', 'O'];
const FIGURES = [1, 2, 3, 4];

const DISTRIBUTION = Object.freeze({
  A: { subject: true, predicate: false },
  E: { subject: true, predicate: true },
  I: { subject: false, predicate: false },
  O: { subject: false, predicate: true },
});

const FIGURE_TERMS = Object.freeze({
  1: { major: ['M', 'P'], minor: ['S', 'M'] },
  2: { major: ['P', 'M'], minor: ['S', 'M'] },
  3: { major: ['M', 'P'], minor: ['M', 'S'] },
  4: { major: ['P', 'M'], minor: ['M', 'S'] },
});

function failure(code, message, details = {}) { return { error: { code, message, ...details } }; }
function isNegative(letter) { return letter === 'E' || letter === 'O'; }
function isParticular(letter) { return letter === 'I' || letter === 'O'; }
function isUniversal(letter) { return letter === 'A' || letter === 'E'; }

function distributedTerms(letter, [subject, predicate]) {
  const rule = DISTRIBUTION[letter];
  return new Set([
    ...(rule.subject ? [subject] : []),
    ...(rule.predicate ? [predicate] : []),
  ]);
}

export function classifyForm(moodInput, figureInput, { semantics = 'aristotelian' } = {}) {
  const mood = String(moodInput || '').toUpperCase();
  const figure = Number(figureInput);
  if (!/^[AEIO]{3}$/.test(mood)) return failure('SYLLOGISM_MOOD', 'mood must contain exactly three letters chosen from A, E, I, O');
  if (!FIGURES.includes(figure)) return failure('SYLLOGISM_FIGURE', 'figure must be 1, 2, 3, or 4');
  if (!['aristotelian', 'boolean'].includes(semantics)) return failure('SYLLOGISM_SEMANTICS', 'semantics must be aristotelian or boolean');

  const [majorMood, minorMood, conclusionMood] = mood;
  const terms = FIGURE_TERMS[figure];
  const majorDistributed = distributedTerms(majorMood, terms.major);
  const minorDistributed = distributedTerms(minorMood, terms.minor);
  const conclusionDistributed = distributedTerms(conclusionMood, ['S', 'P']);
  const premisesDistributed = new Set([...majorDistributed, ...minorDistributed]);
  const reasons = [];
  let fallacy = null;

  if (!majorDistributed.has('M') && !minorDistributed.has('M')) {
    reasons.push('the middle term is undistributed in both premises');
    fallacy ||= 'undistributed middle';
  }
  if (conclusionDistributed.has('P') && !majorDistributed.has('P')) {
    reasons.push('the conclusion distributes the major term although the major premise does not');
    fallacy ||= 'illicit major';
  }
  if (conclusionDistributed.has('S') && !minorDistributed.has('S')) {
    reasons.push('the conclusion distributes the minor term although the minor premise does not');
    fallacy ||= 'illicit minor';
  }

  const premiseNegativeCount = Number(isNegative(majorMood)) + Number(isNegative(minorMood));
  const conclusionNegative = isNegative(conclusionMood);
  if (premiseNegativeCount === 2) reasons.push('two negative premises cannot connect the major and minor terms');
  if (premiseNegativeCount !== Number(conclusionNegative)) reasons.push('the conclusion is negative exactly when one premise is negative');
  if (isParticular(majorMood) && isParticular(minorMood)) reasons.push('two particular premises do not distribute enough terms to force a conclusion');
  if ((isParticular(majorMood) || isParticular(minorMood)) && !isParticular(conclusionMood)) reasons.push('a particular premise cannot support a universal conclusion');

  const existentialOnly = semantics === 'boolean'
    && isUniversal(majorMood) && isUniversal(minorMood) && isParticular(conclusionMood)
    && reasons.length === 0;
  if (existentialOnly) {
    reasons.push('the particular conclusion requires existence that universal premises do not guarantee');
    fallacy = 'existential fallacy';
  }

  const valid = reasons.length === 0;
  const steps = [
    `Form ${mood}-${figure}: major ${majorMood}, minor ${minorMood}, conclusion ${conclusionMood}.`,
    `Distributed in the premises: ${[...premisesDistributed].sort().join(', ') || 'none'}.`,
    valid ? 'All categorical validity rules pass.' : `Validity rule failed: ${reasons[0]}.`,
  ];
  if (fallacy) steps.push(`${fallacy}: ${FALLACY_EXPLANATIONS[fallacy]}`);
  return {
    figure,
    mood,
    valid,
    semantics,
    reasons,
    ...(fallacy ? { fallacy, fallacyExplanation: FALLACY_EXPLANATIONS[fallacy] } : {}),
    steps,
  };
}

function normalizeTerm(text) {
  return String(text || '').trim().replace(/[.?!]+$/u, '').replace(/\s+/gu, ' ').toLocaleLowerCase();
}

export function parseCategorical(sentence) {
  const source = String(sentence ?? '').trim();
  const patterns = [
    { mood: 'O', re: /^some\s+(.+?)\s+are\s+not\s+(.+?)[.?!]?$/iu },
    { mood: 'I', re: /^some\s+(.+?)\s+are\s+(.+?)[.?!]?$/iu },
    { mood: 'E', re: /^no\s+(.+?)\s+are\s+(.+?)[.?!]?$/iu },
    { mood: 'A', re: /^all\s+(.+?)\s+are\s+(.+?)[.?!]?$/iu },
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern.re);
    if (!match) continue;
    const subject = normalizeTerm(match[1]);
    const predicate = normalizeTerm(match[2]);
    if (!subject || !predicate || subject === predicate) return failure('SYLLOGISM_MAPPING_UNCERTAIN', 'the categorical sentence does not contain two distinct terms KL01 can map safely');
    return { mood: pattern.mood, subject, predicate, source };
  }
  return failure('SYLLOGISM_MAPPING_UNCERTAIN', 'could not map the sentence to one of: All A are B, No A are B, Some A are B, Some A are not B');
}

function samePair(statement, a, b) {
  return (statement.subject === a && statement.predicate === b) || (statement.subject === b && statement.predicate === a);
}

function formFromStatements(premises, conclusion) {
  const parsedConclusion = parseCategorical(conclusion);
  if (parsedConclusion.error) return parsedConclusion;
  const parsedPremises = premises.map(parseCategorical);
  const bad = parsedPremises.find(item => item.error);
  if (bad) return bad;
  const S = parsedConclusion.subject;
  const P = parsedConclusion.predicate;
  const allTerms = new Set(parsedPremises.flatMap(item => [item.subject, item.predicate]));
  allTerms.delete(S); allTerms.delete(P);
  if (allTerms.size !== 1) return failure('SYLLOGISM_MAPPING_UNCERTAIN', 'the argument must have exactly three distinct categorical terms');
  const M = [...allTerms][0];
  const majorIndex = parsedPremises.findIndex(item => samePair(item, P, M));
  const minorIndex = parsedPremises.findIndex(item => samePair(item, S, M));
  if (majorIndex < 0 || minorIndex < 0 || majorIndex === minorIndex) return failure('SYLLOGISM_MAPPING_UNCERTAIN', 'the premises do not form one major premise and one minor premise around a single middle term');
  const major = parsedPremises[majorIndex];
  const minor = parsedPremises[minorIndex];
  let figure = null;
  for (const candidate of FIGURES) {
    const pattern = FIGURE_TERMS[candidate];
    const map = { S, P, M };
    if (major.subject === map[pattern.major[0]] && major.predicate === map[pattern.major[1]]
        && minor.subject === map[pattern.minor[0]] && minor.predicate === map[pattern.minor[1]]) {
      figure = candidate; break;
    }
  }
  if (!figure) return failure('SYLLOGISM_MAPPING_UNCERTAIN', 'the term order does not match one of the four standard syllogistic figures');
  return {
    mood: `${major.mood}${minor.mood}${parsedConclusion.mood}`,
    figure,
    terms: { S, P, M },
    statements: { major, minor, conclusion: parsedConclusion },
  };
}

export function analyse(input, options = {}) {
  if (input && typeof input === 'object' && !Array.isArray(input) && input.mood && input.figure) return classifyForm(input.mood, input.figure, options);
  let premises;
  let conclusion;
  if (Array.isArray(input)) {
    if (input.length !== 3) return failure('SYLLOGISM_INPUT', 'provide two premises followed by one conclusion');
    [premises, conclusion] = [input.slice(0, 2), input[2]];
  } else if (input && Array.isArray(input.premises) && typeof input.conclusion === 'string') {
    premises = input.premises; conclusion = input.conclusion;
    if (premises.length !== 2) return failure('SYLLOGISM_INPUT', 'provide exactly two premises');
  } else return failure('SYLLOGISM_INPUT', 'provide two premises and a conclusion, or a mood and figure');
  const mapped = formFromStatements(premises, conclusion);
  if (mapped.error) return mapped;
  const result = classifyForm(mapped.mood, mapped.figure, options);
  if (result.error) return result;
  return {
    ...result,
    terms: mapped.terms,
    statements: mapped.statements,
    steps: [`Mapped the argument to ${mapped.mood}-${mapped.figure}.`, ...result.steps],
  };
}

export function enumerateForms(options = {}) {
  const results = [];
  for (const figure of FIGURES) for (const a of MOODS) for (const b of MOODS) for (const c of MOODS) results.push(classifyForm(`${a}${b}${c}`, figure, options));
  return results;
}
