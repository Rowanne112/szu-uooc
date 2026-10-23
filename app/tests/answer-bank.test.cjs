const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const script = fs.readFileSync(`${__dirname}/../szu-uooc.user.js`, 'utf8');
const functions = ['normalizedAnswerText', 'fillAnswerText', 'canonicalQuestionType', 'readCourseJson', 'courseCacheKey', 'bankAnswer', 'validateCourseAnswer'].map(name => {
  const start = script.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  const next = /\n  (?:async )?function /g;
  next.lastIndex = start + 2;
  const end = next.exec(script)?.index;
  assert.ok(end > start, name);
  return script.slice(start, end);
}).join('\n');

test('scanned questions vary only marked blank lengths and retain exact answer safeguards', () => {
  const fixture = { question: '合法变量名是____。', type: '单选题', options: [{ text: 'a12_3' }, { text: 'float' }], answers: ['a12_3'], ocr_blank_length_uncertain: true };
  const state = { config: { answerBank: JSON.stringify({ questions: [fixture] }) } };
  const context = vm.createContext({ state, localStorage: { getItem: () => null }, COURSE_CACHE_KEY: 'test:' });
  const bankAnswer = vm.runInContext(functions + '\nbankAnswer', context);
  const live = { ...fixture, type: '10', question: '合法变量名是________。', options: [...fixture.options].reverse() };
  assert.equal(bankAnswer('course', live).answers[0], 'a12_3');
  for (const flag of [undefined, false, 'true', 1]) {
    state.config.answerBank = JSON.stringify({ questions: [{ ...fixture, ocr_blank_length_uncertain: flag }] });
    assert.equal(bankAnswer('course', live), null, 'unmarked questions stay exact');
  }
  state.config.answerBank = JSON.stringify({ questions: [fixture] });
  for (const change of [
    { question: '合法变量名是_。' },
    { question: '合法变量名是________?' },
    { type: '11' },
    { options: [{ text: 'a12_4' }, { text: 'float' }] },
    { images: [{ url: 'https://fixture.invalid/question.png' }] },
    { options: [{ text: 'a12_3', images: [{ url: 'https://fixture.invalid/option.png' }] }, { text: 'float' }] },
  ]) assert.equal(bankAnswer('course', { ...live, ...change }), null);
  state.config.answerBank = JSON.stringify({ questions: [{ ...fixture, question: 'a__b是____。' }] });
  assert.equal(bankAnswer('course', { ...live, question: 'a___b是________。' }), null, 'identifier underscores remain exact');
  state.config.answerBank = JSON.stringify({ questions: [fixture, { ...fixture, question: live.question, answers: ['float'] }] });
  assert.throws(() => bankAnswer('course', live), /同题答案冲突/);
  const fill = { question: '填写代码____', type: '填空题', answers: ['printf("Hello  world");\nreturn 0;'], ocr_blank_length_uncertain: true };
  state.config.answerBank = JSON.stringify({ questions: [fill] });
  assert.equal(bankAnswer('course', { ...fill, type: '30', question: '填写代码________' }).answers[0], fill.answers[0], 'fill answer whitespace is preserved');
});

test('normalization preserves code literals and still collapses surrounding layout whitespace', () => {
  const normalize = vm.runInNewContext(functions + '\nnormalizedAnswerText');
  const literal = String.raw`printf("say \"a  b\"");`;
  assert.equal(normalize('  ' + literal + '\u00a0\n +  1  '), literal + ' + 1');
  assert.equal(normalize("What's strlen(\"a'  b\")?"), "What's strlen(\"a'  b\")?");
  for (const value of ["'  '", "L'  '", "u8'  '", '"a\u00a0b"', '"a\\\n  b"', String.raw`"a\\  b"`]) {
    assert.equal(normalize(value), value, value);
  }
  assert.equal(normalize('  plain\u00a0  text\n\t next  '), 'plain text next');
  assert.equal(normalize(0), '');
});

test('bank and cache keys separate literal whitespace without reusing lossy legacy keys', () => {
  const entry = { question: 'strlen("a  b")的值是？', type: '单选题', options: [{ text: '3' }, { text: '4' }], answers: ['4'] };
  const state = { config: { answerBank: JSON.stringify({ questions: [entry] }) } };
  const storage = new Map();
  const context = { state, localStorage: { getItem: key => storage.get(key) ?? null }, COURSE_CACHE_KEY: 'test:' };
  const { bankAnswer, courseCacheKey } = vm.runInNewContext(functions + '\n({ bankAnswer, courseCacheKey })', context);
  const live = { ...entry, type: '10', options: [...entry.options].reverse() };
  const changed = { ...live, question: 'strlen("a b")的值是？' };
  assert.equal(bankAnswer('course', live).answers[0], '4');
  assert.equal(bankAnswer('course', changed), null);
  assert.notEqual(courseCacheKey('course', live), courseCacheKey('course', changed));
  const legacy = 'test:course:' + JSON.stringify([changed.question, '10', ['3', '4'], 0]);
  storage.set(legacy, JSON.stringify({ answers: ['4'], source: 'AI' }));
  state.config.answerBank = '{"questions":[]}';
  assert.equal(bankAnswer('course', changed), null, 'old keys already lost the quoted whitespace distinction');
  assert.equal(storage.size, 1, 'legacy records are retained');
  const plain = { ...changed, question: '普通题' };
  const plainKey = 'test:course:' + JSON.stringify(['普通题', '10', ['3', '4'], 0]);
  assert.equal(courseCacheKey('course', plain), plainKey);
  storage.set(plainKey, JSON.stringify({ answers: ['3'], source: 'AI' }));
  assert.equal(bankAnswer('course', plain).answers[0], '3', 'ordinary existing caches remain reusable');
  storage.set(courseCacheKey('course', changed), JSON.stringify({ answers: ['3'], source: 'AI' }));
  assert.equal(bankAnswer('course', changed).answers[0], '3', 'quoted questions reuse new-format caches');
});

test('choice validation distinguishes quoted spaces and permits both distinct literal options', () => {
  const validate = vm.runInNewContext(functions + '\nvalidateCourseAnswer');
  const question = { type: '11', options: [{ text: '"a  b"' }, { text: '"a b"' }] };
  assert.doesNotThrow(() => validate(question, ['"a  b"', '"a b"']));
  assert.throws(() => validate(question, ['"a   b"']), /无法唯一匹配/);
});
