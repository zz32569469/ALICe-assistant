#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 要擋的字眼放在本機的 local/company-terms.json（字串陣列，不進 git），或用環境變數 ALICE_TERMS_FILE 指定。
 * 沒有清單時不檢查（公開的 repo 本身不帶任何清單）。
 */
function loadTerms(repoRoot = path.resolve(__dirname, '..')) {
  const file = process.env.ALICE_TERMS_FILE || path.join(repoRoot, 'local', 'company-terms.json');
  if (!fs.existsSync(file)) return [];
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(value) || !value.every((term) => typeof term === 'string' && term.trim() !== '')) throw new Error(`${file} 必須是字串陣列`);
  return value;
}

function filesBelow(root) {
  if (!fs.existsSync(root)) return [];
  if (fs.statSync(root).isFile()) return [root];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/** 被 .gitignore 排除的檔不會推送，不檢查（例：只存在本機的艾莉絲建議檔）。不在 git repo 裡時全部檢查。 */
function gitIgnored(repoRoot, files) {
  if (files.length === 0) return new Set();
  try {
    // -z：以 NUL 分隔輸入輸出，git 不會把中文檔名轉成跳脫字串。
    const output = execFileSync('git', ['-C', repoRoot, 'check-ignore', '-z', '--stdin'], {
      input: files.map((file) => path.relative(repoRoot, file).split(path.sep).join('/')).join('\0'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return new Set(output.split('\0').filter(Boolean).map((relative) => path.resolve(repoRoot, relative)));
  } catch (error) {
    // check-ignore 沒有任何檔被排除時結束碼是 1。
    return new Set(String(error.stdout ?? '').split('\0').filter(Boolean).map((relative) => path.resolve(repoRoot, relative)));
  }
}

function scanCompanyTerms(roots, repoRoot = path.resolve(__dirname, '..'), terms = loadTerms(repoRoot)) {
  const hits = [];
  const files = roots.flatMap((root) => filesBelow(root));
  const ignored = gitIgnored(repoRoot, files);
  for (const root of roots) {
    for (const file of filesBelow(root)) {
      if (ignored.has(path.resolve(file))) continue;
      const buffer = fs.readFileSync(file);
      if (buffer.includes(0)) continue;
      const lines = buffer.toString('utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        const lower = line.toLocaleLowerCase();
        for (const term of terms) {
          if (lower.includes(term.toLocaleLowerCase())) {
            hits.push({ file, line: index + 1, term });
          }
        }
      });
    }
  }
  return hits;
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  // 預設只查範本；--all 查整個 repo 會進版控的檔（推送前使用）。
  const roots = process.argv.includes('--all')
    ? execFileSync('git', ['-C', repoRoot, 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean).map((relative) => path.join(repoRoot, relative)).filter((full) => fs.existsSync(full))
    : [path.join(repoRoot, 'kb-template'), path.join(repoRoot, 'scripts')];
  if (loadTerms(repoRoot).length === 0) {
    console.log('公司字眼檢查：沒有本機清單（local/company-terms.json），略過');
    return [];
  }
  const hits = scanCompanyTerms(roots);
  if (hits.length) {
    for (const hit of hits) {
      console.error(`${path.relative(repoRoot, hit.file)}:${hit.line}: ${hit.term}`);
    }
    console.error(`公司字眼檢查：${hits.length} 筆`);
    process.exitCode = 1;
  } else {
    console.log('公司字眼檢查：0 筆');
  }
  return hits;
}

if (require.main === module) main();

module.exports = { scanCompanyTerms, loadTerms };
