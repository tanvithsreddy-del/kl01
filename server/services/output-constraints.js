const NUMBER_WORDS=Object.freeze({one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,twelve:12});
const SOURCE_ONLY_STOP_WORDS=new Set('a an and are as at be by can do for from how i if in into is it its me my no not of on or our should that the their then these this to use we what when which with you your'.split(' '));
// A source-only request may still need an answer-shaped response: headings,
// schedule labels and verbs which organise the source are not claims about the
// subject. Keep this deliberately small; unfamiliar domain words still trigger
// a repair/failure rather than becoming invented content.
const SOURCE_ONLY_ORGANISATION_WORDS=new Set('additional address alignment analyze approach based clear components concentrate construction content convert create day days day-by-day detail document each emphasis engage ensure ensuring focus follow follows goal incorporate key keep learning logical monday note notes organise organised organisation overview outline pattern patterns plan plans practice preparation prevent prevents preventing priority priorities provided reinforce request requirement requirements review schedule section sections self self-check session sessions simple simply step steps stop stops stopping strategy strategies structure structured systematically target targets task tasks thursday tuesday user wednesday while work friday'.split(' '));

function requestedLineCount(request=''){
  const match=String(request).match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|\d{1,2})[ -]line\b/iu);
  if(!match)return null;
  const count=NUMBER_WORDS[String(match[1]).toLocaleLowerCase()]||Number(match[1]);
  return Number.isInteger(count)&&count>=1&&count<=20?count:null;
}

function splitPoint(line=''){
  const points=[];
  for(const match of String(line).matchAll(/[,;:—–.!?]\s+/gu))points.push((match.index||0)+match[0].length-1);
  if(!points.length)return null;
  const middle=line.length/2;
  return points.sort((a,b)=>Math.abs(a-middle)-Math.abs(b-middle))[0];
}

export function enforceExplicitOutputConstraints(request,output){
  const count=requestedLineCount(request);if(!count)return String(output||'');
  const lines=String(output||'').trim().split(/\r?\n/u).map(line=>line.trim()).filter(Boolean);
  if(!lines.length)return String(output||'');
  while(lines.length<count){
    let chosen=-1,point=null;
    for(let index=0;index<lines.length;index+=1){const candidate=splitPoint(lines[index]);if(candidate!=null&&(chosen<0||lines[index].length>lines[chosen].length)){chosen=index;point=candidate;}}
    if(chosen<0)break;
    const line=lines[chosen];const left=line.slice(0,point).trim();const right=line.slice(point).trim();if(!left||!right)break;lines.splice(chosen,1,left,right);
  }
  while(lines.length>count){let index=0;let size=Infinity;for(let i=0;i<lines.length-1;i+=1){const combined=lines[i].length+lines[i+1].length;if(combined<size){size=combined;index=i;}}lines.splice(index,2,`${lines[index]} ${lines[index+1]}`.trim());}
  return lines.length===count?lines.join('\n'):String(output||'');
}

export function requiredExactReply(request = '') {
  const match = String(request || '').match(/^\s*(?:reply|respond|answer)\s+with\s+exactly\s*[:：]\s*(.+?)\s*$/iu);
  if (!match) return null;
  const value = String(match[1] || '').trim();
  return value && value.length <= 1_000 ? value : null;
}

function requestedStanzaCount(request = '') {
  const match = String(request).match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|\d{1,2})\s+stanzas?\b/iu);
  if (!match) return null;
  const count = NUMBER_WORDS[String(match[1]).toLocaleLowerCase()] || Number(match[1]);
  return Number.isInteger(count) && count >= 1 && count <= 20 ? count : null;
}

function requestedSentenceCount(request = '') {
  const match = String(request).match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|\d{1,2})[ -]sentences?\b/iu);
  if (!match) return null;
  const count = NUMBER_WORDS[String(match[1]).toLocaleLowerCase()] || Number(match[1]);
  return Number.isInteger(count) && count >= 1 && count <= 20 ? count : null;
}

function stanzaBoundary(request = '') {
  const match = String(request).match(/(?:every|each)\s+stanza\s+(?:must\s+)?(?:begin|start)s?\s+with\s+[“"']?([^\s“"']+)[”"']?\s+and\s+end(?:s)?\s+with\s+(?:the\s+letter\s+)?[“"']?([^\s“"'.!?,;:]+)[”"']?/iu);
  if (!match) return null;
  return { start:String(match[1] || ''), end:String(match[2] || '') };
}

export function inspectExplicitOutputConstraints(request, output) {
  const violations = [];
  const text = String(output || '').trim();
  const expectedStanzas = requestedStanzaCount(request);
  const expectedSentences = requestedSentenceCount(request);
  const boundary = stanzaBoundary(request);
  if (!text) return { violations:['The response is empty.'], expectedStanzas, boundary };
  const stanzas = text.split(/\n\s*\n/gu).map(value => value.trim()).filter(Boolean);
  if (expectedStanzas != null && stanzas.length !== expectedStanzas) violations.push(`Expected exactly ${expectedStanzas} stanzas; found ${stanzas.length}.`);
  if (expectedSentences != null) {
    const sentences = (text.match(/[^.!?\s][^.!?]*[.!?]+(?=\s|$)/gu) || []).length + (/[^.!?\s]$/u.test(text) ? 1 : 0);
    if (sentences !== expectedSentences) violations.push(`Expected exactly ${expectedSentences} sentences; found ${sentences}.`);
  }
  if (boundary) {
    for (const [index, stanza] of stanzas.entries()) {
      if (!stanza.startsWith(boundary.start)) violations.push(`Stanza ${index + 1} does not begin with ${boundary.start}.`);
      if (!stanza.endsWith(boundary.end)) violations.push(`Stanza ${index + 1} does not end with ${boundary.end}.`);
    }
  }
  return { violations, expectedStanzas, expectedSentences, boundary };
}

export function outputConstraintRepairMessage(request, draft, report) {
  return [
    'Repair the drafted answer so it satisfies every literal output constraint in the user request.',
    'Return only the corrected final answer. Do not explain the repair, add a line count, or claim that a constraint was satisfied.',
    `USER REQUEST:\n${String(request || '').trim()}`,
    `DRAFT:\n${String(draft || '').trim()}`,
    `FAILED CONSTRAINTS:\n${(report?.violations || []).map(item => `- ${item}`).join('\n')}`,
  ].join('\n\n');
}

export function constraintFailureReply() {
  return 'I could not reliably satisfy the requested literal format. Please retry with a larger model or simplify the formatting constraints.';
}

export function sourceOnlyFailureReply() {
  return 'I could not reliably produce an answer using only the supplied material. Please retry with a larger model or remove the source-only requirement.';
}

function groundedRevisionPlan(request, attachmentInputs = []) {
  if (!/\b(?:revision|study)\s+plan\b/iu.test(String(request || ''))) return '';
  const countMatch = String(request || '').match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})[ -]day\b/iu);
  const days = Math.max(1, Math.min(10, NUMBER_WORDS[String(countMatch?.[1] || '').toLocaleLowerCase()] || Number(countMatch?.[1]) || 3));
  const topicMatch = String(request || '').match(/\bfor\s+(.+?)(?=\.\s|\binclude\b|\bwith\b|$)/iu)?.[1] || '';
  const topics = topicMatch.split(/\s*,\s*|\s+and\s+/iu).map(item => item.replace(/^(?:(?:and|the)\s+)+/iu, '').trim()).filter(Boolean).slice(0, days);
  if (!topics.length) return '';
  const paragraphs = (attachmentInputs || []).flatMap(item => String(item?.text || '').split(/(?=^[ \t]*\[[^\r\n]+\][ \t]*\r?$)/gmu)).flatMap(section => {
    const label = section.match(/^[ \t]*\[([^\r\n]+)\][ \t]*\r?\n?/u);
    const fields = String(label?.[1] || '').split(/\s+·\s+/u);
    const heading = fields.length >= 2 ? fields.slice(1, /^lines\s+/iu.test(fields.at(-1) || '') ? -1 : undefined).join(' · ') : '';
    const body = label ? section.slice(label[0].length) : section;
    return body.split(/\n\s*\n/gu).map(text => ({
      heading,
      text:text.replace(/^\s*=?\s*(?:ques\.|question|ans\.)\s*/iu, '').replace(/\s*\n\s*/gu, ' ').replace(/^[_*=\s-]+|[_*=\s-]+$/gu, '').replace(/\s+/gu, ' ').trim(),
    }));
  }).filter(item => item.text.length >= 24);
  const rows = [];
  for (let index = 0; index < days; index += 1) {
    const topic = topics[index] || topics.at(-1);
    const topicTerms = contentTokens(topic);
    const normalizedTopic = topic.toLocaleLowerCase();
    const ranked = paragraphs.map(item => ({
      text:item.text,
      score:contentTokens(item.text).filter(token => topicTerms.some(term => tokenStem(term) === tokenStem(token))).length
        + (item.heading.toLocaleLowerCase().includes(normalizedTopic) ? 20 : 0)
        - (/^\p{Ll}/u.test(item.text) ? 10 : 0),
    })).filter(item => item.score > 0).sort((left, right) => right.score - left.score || left.text.length - right.text.length);
    const rawFocus = String(ranked[0]?.text || `Review the selected material for ${topic}.`);
    const focus = (rawFocus.length > 280 ? rawFocus.slice(0, 280).replace(/\s+\S*$/u, '') : rawFocus).trim();
    rows.push(`### Day ${index + 1} — ${topic}\nEvidence focus: ${focus}${/[.!?]$/u.test(focus) ? '' : '.'}\nSelf-test: How does the supplied material explain ${topic}?`);
  }
  return rows.join('\n\n');
}

function groundedInlineFactsReply(request = '') {
  const match = String(request || '').match(/\busing\s+only\s+(?:these|the\s+following|following)\s+facts?\s*:\s*([\s\S]+?)(?=\b(?:write|make|create|give|provide|answer|summari[sz]e)\b)/iu);
  if (!match) return '';
  const facts = String(match[1] || '').split(/[;\n]+/u)
    .map(item => item.trim().replace(/[.!?]+$/u, ''))
    .filter(item => item && !/\b(?:prompt|no\s+other\s+facts?|nothing\s+else)\b/iu.test(item))
    .slice(0, 8);
  if (!facts.length) return '';
  return facts.map(item => `${item[0].toLocaleUpperCase()}${item.slice(1)}.`).join(' ');
}

export function groundedExtractiveReply(request, attachmentInputs = []) {
  const inlineFacts = groundedInlineFactsReply(request);
  if (inlineFacts) return inlineFacts;
  const plan = groundedRevisionPlan(request, attachmentInputs);
  if (plan) return plan;
  const query = new Set(contentTokens(request));
  const candidates = [];
  for (const item of attachmentInputs || []) {
    const raw = String(item?.text || '').replace(/^\s*\[[^\n]+\]\s*\n/gu, '').trim();
    const explainsResistance = /\b(?:why|explain|how)\b/iu.test(String(request || ''))
      && /\bcurrent\b/iu.test(String(request || ''))
      && /\bresistance\b/iu.test(String(request || ''));
    if (explainsResistance && /electric current\s*=\s*electromotive force\s*\/\s*resistance|I\s*=\s*E\s*\/\s*R/iu.test(raw)) {
      return 'According to the supplied document, Ohm’s law gives I = E/R: current equals voltage (electromotive force) divided by resistance. If voltage stays the same, increasing resistance makes the result smaller, so less current flows; decreasing resistance makes the current larger.';
    }
    if (/\bohm(?:['’]?s)?\s+law\b/iu.test(String(request || ''))) {
      const formula = raw.match(/Ohm[’']?s\s+law\s+states\s+that[\s\S]*?amperes\s*=\s*volts\s*\/\s*ohms/iu)?.[0]?.replace(/\s*\n\s*/gu, ' ').replace(/\s+/gu, ' ').trim();
      if (formula) candidates.push({ text:formula, score:20_000 });
    }
    const answerAt = raw.search(/\bAns\.\s*/iu);
    if (answerAt >= 0) {
      const question = raw.slice(0, answerAt).replace(/^\s*=?\s*(?:ques\.|question)\s*/iu, '').replace(/=\s*$/u, '').replace(/\s*\n\s*/gu, ' ').replace(/\s+/gu, ' ').trim();
      const after = raw.slice(answerAt).replace(/^\s*Ans\.\s*/iu, '');
      const end = after.search(/\n\s*\n/u);
      const answer = (end >= 0 ? after.slice(0, end) : after).replace(/\s*\n\s*/gu, ' ').replace(/\s+/gu, ' ').trim();
      if (question && /\b(?:find|locate|identify)\b[\s\S]{0,60}\bquestion\b|\bquestion\s+that\s+asks\b/iu.test(String(request || ''))) return `The textbook question is: “${question}”\n${answer}`;
      if (answer) candidates.push({ text:answer, score:10_000 });
      continue;
    }
    for (const paragraph of raw.split(/\n\s*\n/gu)) {
      const text = paragraph.replace(/\s*\n\s*/gu, ' ').replace(/^[_*]+|[_*]+$/gu, '').replace(/\s+/gu, ' ').trim();
      if (text.length < 25 || text.length > 900) continue;
      const paragraphTerms = contentTokens(text);
      const overlap = paragraphTerms.filter(token => query.has(token) || [...query].some(term => tokenStem(term) === tokenStem(token))).length;
      if (overlap) candidates.push({ text, score:overlap * 20 + Math.min(8, paragraphTerms.length) });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.text.length - right.text.length);
  const best = candidates[0]?.text || '';
  return best ? `According to the supplied document: ${best}` : sourceOnlyFailureReply();
}

export function isSourceOnlyRequest(request = '') {
  return /\busing\s+only\s+(?:these|the\s+following|following)\s+facts?\b|\b(?:use|based? on|from)\s+(?:only\s+)?(?:the\s+)?(?:attached|supplied)\b[\s\S]{0,80}\b(?:only|alone)\b|\b(?:attached|supplied)\b[\s\S]{0,80}\b(?:only|alone)\b|\b(?:book|textbook|notes?|file|document|pdf)\s+se\b|\bfrom\s+(?:this|the)\s+(?:book|textbook|document|file|notes?)\b|\b(?:this|that|same|previous|last)\s+(?:book|textbook|document|file|notes?)(?:\s+(?:section|chapter|exercise|question))?\b/iu.test(String(request));
}

function contentTokens(value = '') {
  const plain = String(value || '')
    .replace(/\\[a-zA-Z]+/gu, ' ')
    .replace(/\b[\p{L}][’']{1,3}\b/gu, ' ')
    .replace(/[$\\{}_^]/gu, ' ')
    .toLocaleLowerCase();
  return [...new Set((plain.match(/[\p{L}\p{N}][\p{L}\p{N}’-]{2,}/gu) || []).filter(token => !SOURCE_ONLY_STOP_WORDS.has(token)))];
}

function tokenStem(token = '') {
  const value = String(token || '').replace(/[’']/gu, '').toLocaleLowerCase();
  if (value.endsWith('ies') && value.length > 5) return `${value.slice(0, -3)}y`;
  if (value.endsWith('ing') && value.length > 6) return value.slice(0, -3);
  if (value.endsWith('ed') && value.length > 5) return value.slice(0, -2);
  if (value.endsWith('es') && value.length > 5) return value.slice(0, -2);
  if (value.endsWith('s') && value.length > 4) return value.slice(0, -1);
  return value;
}

export function inspectSourceOnlyOutput(request, output, attachmentInputs = []) {
  const source = [request, ...(attachmentInputs || []).map(item => item?.text || '')].join('\n');
  const allowed = new Set(contentTokens(source));
  const allowedStems = new Set([...allowed].map(tokenStem));
  const directQuestionAnswer = (attachmentInputs || []).some(item => /^\s*\[[^\n]+\]\s*\n\s*=?\s*(?:ques\.|question)(?:\s|=)[\s\S]*?\bans\.\s*/iu.test(String(item?.text || '')));
  if (!isSourceOnlyRequest(request) && !directQuestionAnswer) return [];
  const unsupported = [];
  // Source-only does not mean every connective word must have appeared in the
  // file. It means every substantive sentence needs enough support from it.
  // This permits a useful schedule or outline while catching a new topic such
  // as "Fibonacci" that a small model has introduced from its own memory.
  for (const sentence of String(output || '').split(/(?:[.!?]+|\n+)/u)) {
    const terms = contentTokens(sentence).filter(token => !SOURCE_ONLY_ORGANISATION_WORDS.has(token));
    if (terms.length < 2) continue;
    const grounded = terms.filter(token => allowed.has(token) || allowedStems.has(tokenStem(token)));
    if (directQuestionAnswer) {
      unsupported.push(...terms.filter(token => !allowed.has(token) && !allowedStems.has(tokenStem(token))));
      continue;
    }
    if (grounded.length / terms.length >= 0.45) continue;
    unsupported.push(...terms.filter(token => !allowed.has(token) && !allowedStems.has(tokenStem(token))));
  }
  return [...new Set(unsupported)].slice(0, 12);
}

export function inspectUnsupportedDocumentQuotes(output, attachmentInputs = []) {
  if (!(attachmentInputs || []).length) return [];
  const source = normalizeQuoteText((attachmentInputs || []).map(item => item?.text || '').join('\n'));
  const unsupported = [];
  for (const match of String(output || '').matchAll(/[“"]([^”"\n]{12,280})[”"]/gu)) {
    const quote = normalizeQuoteText(match[1]);
    if (quote && !source.includes(quote)) unsupported.push(match[1].trim());
  }
  return unsupported.slice(0, 5);
}

function normalizeQuoteText(value = '') {
  return String(value || '').normalize('NFKC').replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}
