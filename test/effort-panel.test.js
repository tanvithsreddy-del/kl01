import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('effort controls present explicit Web Search Off, Auto, and On modes', async () => {
  const effort = await fs.readFile(path.join(root, 'web', 'js', 'components', 'advanced-panel.js'), 'utf8');
  assert.match(effort, /aria-label':'Web search mode/u);
  assert.match(effort, /value:'off'.+Off — never search/u);
  assert.match(effort, /value:'auto'.+Auto — search when needed/u);
  assert.match(effort, /value:'force'.+On — always search/u);
});
