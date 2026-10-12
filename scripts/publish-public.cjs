#!/usr/bin/env node
'use strict';

// 把目前的程式同步到公開 repo：公開 repo 有自己的歷史（從第一次發布開始），不帶私人 repo 的舊提交。
// 做法：用 HEAD 的檔案內容在本機分支 `public` 上做一筆提交（上一筆是 public 分支的前一次發布），推到遠端 `public` 的 main。
// 介紹網頁：HEAD 的 site/ 資料夾另外提交到本機分支 `public-pages`，推到遠端的 gh-pages（GitHub Pages 從這個分支提供網頁）。
// 推送前一定先跑字眼檢查：本機清單（local/company-terms.json）必須存在、而且 0 筆才會繼續。
//
// 用法：
//   git remote add public <公開 repo 的網址>   （第一次）
//   node scripts/publish-public.cjs [--message "說明"] [--dry-run]

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { loadTerms, scanCompanyTerms } = require('./check-company-terms.cjs');

const repoRoot = path.resolve(__dirname, '..');
const git = (args, options = {}) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', ...options }).trim();

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function tryGit(args) {
  try {
    return git(args, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

// 把 tree 提交到本機分支 localBranch（接在上一次發布後面），推到 public 的 remoteBranch；內容沒變就不做。
function publishTree({ tree, localBranch, remoteBranch, subject, firstSubject, dryRun }) {
  const parent = tryGit(['rev-parse', '--verify', `refs/heads/${localBranch}`]);
  if (parent !== undefined && git(['rev-parse', `${parent}^{tree}`]) === tree) {
    console.log(`${remoteBranch}：已經是最新的內容，不用發布`);
    return;
  }
  const title = parent === undefined ? firstSubject : subject;
  if (dryRun) {
    console.log(`（試跑）${remoteBranch}：會在 ${localBranch} 分支提交「${title}」${parent === undefined ? '（第一筆）' : ''}`);
    return;
  }
  const message = `${title}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n`;
  const commit = git(['commit-tree', tree, ...(parent === undefined ? [] : ['-p', parent]), '-F', '-'], { input: message });
  git(['update-ref', `refs/heads/${localBranch}`, commit]);
  execFileSync('git', ['-C', repoRoot, 'push', 'public', `${localBranch}:${remoteBranch}`], { stdio: 'inherit' });
  console.log(`${remoteBranch}：已發布 ${commit.slice(0, 7)} ${title}`);
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (git(['status', '--porcelain']) !== '') throw new Error('還有沒提交的修改，請先提交（發布的是最新的提交）');
  if (tryGit(['remote', 'get-url', 'public']) === undefined) throw new Error('還沒設定公開 repo：git remote add public <網址>');
  if (loadTerms(repoRoot).length === 0) throw new Error('找不到本機字眼清單 local/company-terms.json；沒有清單不發布');
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean).map((relative) => path.join(repoRoot, relative));
  const hits = scanCompanyTerms(files, repoRoot);
  if (hits.length > 0) {
    for (const hit of hits.slice(0, 20)) console.error(`${path.relative(repoRoot, hit.file)}:${hit.line}: ${hit.term}`);
    throw new Error(`字眼檢查有 ${hits.length} 筆，不發布`);
  }

  const subject = option('--message') ?? `同步：${git(['log', '-1', '--format=%s'])}`;
  publishTree({
    tree: git(['rev-parse', 'HEAD^{tree}']),
    localBranch: 'public',
    remoteBranch: 'main',
    subject,
    firstSubject: option('--message') ?? 'ALICe 第一次公開發布',
    dryRun,
  });
  const siteTree = tryGit(['rev-parse', 'HEAD:site']);
  if (siteTree !== undefined) {
    publishTree({ tree: siteTree, localBranch: 'public-pages', remoteBranch: 'gh-pages', subject, firstSubject: '介紹網頁第一次發布', dryRun });
  }
}

try {
  main();
} catch (error) {
  console.error(`發布失敗：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
