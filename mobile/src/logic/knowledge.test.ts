import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOOK_NOTE, bookProblem, COMPETITION_NOTE, competitionProblem, statusTone } from './knowledge';

test('K-5 (app) the book form says plainly that the text is not saved', () => {
  assert.match(BOOK_NOTE, /not saved/);
  assert.match(COMPETITION_NOTE, /sizing|sized/);
});

test('the book form asks for the book, a whole page number and the text', () => {
  assert.equal(bookProblem({ book: '', page: '3', pasted: 'x' }), 'Say which book it is from.');
  assert.equal(bookProblem({ book: 'B', page: '0', pasted: 'x' }), 'Give the page the chapter starts on.');
  assert.equal(bookProblem({ book: 'B', page: '2.5', pasted: 'x' }), 'Give the page the chapter starts on.');
  assert.equal(bookProblem({ book: 'B', page: '3', pasted: '  ' }), 'Paste the chapter text.');
  assert.equal(bookProblem({ book: 'B', page: '3', pasted: 'x' }), null);
});

test('the competition form needs the competition, a name and the entry idea', () => {
  assert.equal(competitionProblem({ competition: '', name: 'n', symbol: '', entry: 'e' }), 'Say which competition it came from.');
  assert.equal(competitionProblem({ competition: 'c', name: '', symbol: '', entry: 'e' }), 'Give the method a short name.');
  assert.equal(competitionProblem({ competition: 'c', name: 'n', symbol: '', entry: '' }), 'Describe the entry idea.');
  assert.equal(competitionProblem({ competition: 'c', name: 'n', symbol: '', entry: 'e' }), null);
});

test('K-6 (app) only measured results turn a status green or red', () => {
  assert.equal(statusTone('untested'), 'neutral');
  assert.equal(statusTone('supported by 2 outcomes'), 'good');
  assert.equal(statusTone('contradicted by 3 outcomes'), 'critical');
});
