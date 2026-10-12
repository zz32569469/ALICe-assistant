'use strict';

// setup／update／doctor 的單元測試（§29）。執行：node scripts/maintenance.test.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { check, versionAtLeast } = require('./doctor.cjs');
const { planUpdate } = require('./update.cjs');

// 測試版本比較：Vite 8 需要 Node 20.19 以上。
test('versionAtLeast compares node versions', () => {
  assert.equal(versionAtLeast('v20.19.0', [20, 19, 0]), true);
  assert.equal(versionAtLeast('v22.1.0', [20, 19, 0]), true);
  assert.equal(versionAtLeast('v20.18.9', [20, 19, 0]), false);
  assert.equal(versionAtLeast('v18.20.0', [20, 19, 0]), false);
});

// 測試更新時只做必要的事：改 core 程式只重建 core；改 package.json 才重裝；改轉接規則要提醒重開 ALICE。
test('planUpdate only rebuilds what changed', () => {
  assert.deepEqual(planUpdate(['core/src/main.ts']), {
    installCore: false, buildCore: true, installStudio: false, buildStudio: false, restartCore: true, reopenRelay: false, reopenSessions: false, kbTemplate: false,
  });
  const packages = planUpdate(['studio/package-lock.json', 'relay/CLAUDE.md', 'kb-template/global-CLAUDE.md']);
  assert.equal(packages.installStudio, true);
  assert.equal(packages.buildStudio, true);
  assert.equal(packages.restartCore, false);
  assert.equal(packages.reopenRelay, true);
  assert.equal(packages.kbTemplate, true);
  assert.equal(planUpdate(['docs/規劃紀錄.md']).buildCore, false);
  assert.equal(planUpdate([], { rebuildAll: true }).installCore, true);
  assert.equal(planUpdate(['persona/alice.md']).restartCore, true);
  assert.equal(planUpdate(['mods/alice-guard/hooks/register.js']).reopenSessions, true);
});

// 測試健康檢查在空白電腦上列出缺什麼、怎麼補（Node 太舊、沒安裝、沒本機設定、沒事實檔）。
test('doctor reports what a fresh machine is missing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-doctor-'));
  try {
    const checks = await check({ repoRoot: root, nodeVersion: 'v18.0.0', skipLogin: true });
    const errors = checks.filter((entry) => entry.level === 'error').map((entry) => entry.item);
    assert.deepEqual(errors, ['Node.js', 'Core 相依套件', '本機設定']);
    assert.ok(checks.some((entry) => entry.item === 'Web Studio' && entry.level === 'warn'));
    assert.ok(checks.some((entry) => entry.item === '事實檔' && entry.level === 'warn' && /facts\.example\.md/u.test(entry.fix)));
    assert.ok(checks.every((entry) => entry.level === 'ok' || typeof entry.fix === 'string' || entry.item === 'Web Studio'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
