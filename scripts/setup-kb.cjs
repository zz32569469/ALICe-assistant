#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_ROOT = path.join(REPO_ROOT, 'kb-template');
const EMPTY_VAULT_DIRS = [
  'raw/assets',
  'raw/inbox',
  'wiki/來源',
  'wiki/分析',
  '_meta/scripts',
  '_meta/archive',
];

/** §91：網頁版 Studio 的網址來源（公開 repo 的 GitHub Pages）。 */
const HOSTED_STUDIO_ORIGIN = 'https://zz32569469.github.io';

function parseArgs(argv) {
  const options = {
    workspace: path.dirname(REPO_ROOT),
    claudeHome: path.join(os.homedir(), '.claude'),
    codexHome: path.join(os.homedir(), '.codex'),
    installClaude: 'ask',
    globalClaudeMd: 'ask',
    codex: 'auto',
    dryRun: false,
    yes: false,
  };
  const valueOptions = new Map([
    ['--kb', 'kb'],
    ['--workspace', 'workspace'],
    ['--claude-home', 'claudeHome'],
    ['--codex-home', 'codexHome'],
    ['--install-claude', 'installClaude'],
    ['--global-claude-md', 'globalClaudeMd'],
    ['--codex', 'codex'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--yes') options.yes = true;
    else if (valueOptions.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要一個值`);
      options[valueOptions.get(arg)] = value;
      index += 1;
    } else {
      throw new Error(`不支援的參數：${arg}`);
    }
  }

  for (const [flag, value] of [
    ['--install-claude', options.installClaude],
    ['--global-claude-md', options.globalClaudeMd],
  ]) {
    if (!['yes', 'no', 'ask'].includes(value)) {
      throw new Error(`${flag} 只能是 yes、no 或 ask`);
    }
  }
  if (!['auto', 'yes', 'no'].includes(options.codex)) {
    throw new Error('--codex 只能是 auto、yes 或 no');
  }
  return options;
}

function detectCodex() {
  const spawnOptions = {
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    windowsHide: true,
  };
  const version = spawnSync('codex', ['--version'], spawnOptions);
  const login = spawnSync('codex', ['login', 'status'], spawnOptions);
  if (version.error || version.status !== 0) {
    return { available: false, reason: '未安裝' };
  }

  if (login.error || login.status !== 0) {
    return { available: false, reason: '未登入' };
  }
  const loginOutput = `${login.stdout || ''}\n${login.stderr || ''}`;
  if (!loginOutput.includes('ChatGPT')) {
    return { available: false, reason: '非 ChatGPT 登入' };
  }
  return { available: true };
}

function slash(value) {
  return path.resolve(value).replace(/\\/g, '/');
}

function localDate(now) {
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function replacePlaceholders(text, replacements) {
  return text
    .replace(/\{\{(KB_PATH|WORKSPACE|USERPROFILE|DATE)\}\}/g, (_, key) => replacements[key])
    .replace(/\{\{title\}\}/g, '<title>')
    .replace(/\{\{date:YYYY-MM-DD\}\}/g, replacements.DATE);
}

function listFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function isText(buffer) {
  return !buffer.includes(0);
}

function createWriter({ dryRun, output }) {
  const result = { created: [], skipped: [] };

  function write(destination, data) {
    const resolved = path.resolve(destination);
    if (fs.existsSync(resolved)) {
      result.skipped.push(resolved);
      output(`略過：${resolved}`);
      return;
    }
    if (!dryRun) {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, data, { flag: 'wx' });
    }
    result.created.push(resolved);
    output(`${dryRun ? '會新建' : '新建'}：${resolved}`);
  }

  function copyTree(sourceRoot, destinationRoot, replacements) {
    for (const source of listFiles(sourceRoot)) {
      const destination = path.join(destinationRoot, path.relative(sourceRoot, source));
      const buffer = fs.readFileSync(source);
      const data = isText(buffer)
        ? replacePlaceholders(buffer.toString('utf8'), replacements)
        : buffer;
      write(destination, data);
    }
  }

  return { result, write, copyTree };
}

async function defaultPrompt(question) {
  // §84：沒有鍵盤輸入（例如在背景或由其他程式執行）時用預設值；否則 readline 等不到回答，程式會默默結束、本機設定沒寫出來。
  if (!process.stdin.isTTY) {
    console.log(`${question}（沒有鍵盤輸入，用預設值）`);
    return '';
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function choose(value, question, options, prompt) {
  if (value === 'yes') return true;
  if (value === 'no') return false;
  if (options.yes) return true;
  const answer = (await prompt(`${question} [y/N] `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

async function main(argv = process.argv.slice(2), runtime = {}) {
  const repoRoot = path.resolve(runtime.repoRoot || REPO_ROOT);
  const templateRoot = path.resolve(runtime.templateRoot || TEMPLATE_ROOT);
  const home = path.resolve(runtime.home || os.homedir());
  const output = runtime.output || (line => console.log(line));
  const prompt = runtime.prompt || defaultPrompt;
  const detectCodexRuntime = runtime.detectCodex || detectCodex;
  const now = runtime.now || new Date();
  const options = parseArgs(argv);

  let codexAvailable;
  if (options.codex === 'auto') {
    const detection = detectCodexRuntime();
    codexAvailable = detection.available;
    output(codexAvailable ? 'Codex 偵測：可用（ChatGPT 登入）' : `Codex 偵測：${detection.reason}`);
  } else {
    codexAvailable = options.codex === 'yes';
  }

  if (!options.kb) {
    options.kb = (await prompt('新 vault 路徑：')).trim();
    if (!options.kb) throw new Error('--kb 為必填');
  }

  const kb = path.resolve(options.kb);
  const workspace = path.resolve(options.workspace);
  const claudeHome = path.resolve(options.claudeHome);
  const codexHome = path.resolve(options.codexHome);
  const replacements = {
    KB_PATH: slash(kb),
    WORKSPACE: slash(workspace),
    USERPROFILE: slash(home),
    DATE: localDate(now),
  };
  const writer = createWriter({ dryRun: options.dryRun, output });

  writer.copyTree(path.join(templateRoot, 'vault'), kb, replacements);
  for (const relative of EMPTY_VAULT_DIRS) {
    writer.write(path.join(kb, relative, '.gitkeep'), '');
  }
  writer.write(
    path.join(kb, '.obsidian', 'app.json'),
    `${JSON.stringify({ userIgnoreFilters: ['_meta/archive/'] }, null, 2)}\n`,
  );

  if (await choose(options.installClaude, '安裝 Claude Code skills 與 scripts？', options, prompt)) {
    const skills = codexAvailable ? ['board', 'codex-usage', 'delegate', 'grilling', 'kb'] : ['grilling', 'kb'];
    for (const skill of skills) {
      writer.copyTree(
        path.join(templateRoot, 'claude', 'skills', skill),
        path.join(claudeHome, 'skills', skill),
        replacements,
      );
    }
    if (codexAvailable) {
      writer.copyTree(path.join(templateRoot, 'claude', 'scripts'), path.join(claudeHome, 'scripts'), replacements);
    }
  }

  const globalClaude = path.join(claudeHome, 'CLAUDE.md');
  if (fs.existsSync(globalClaude)) {
    writer.result.skipped.push(globalClaude);
    output(`略過：${globalClaude}`);
    output('現有 CLAUDE.md 不會覆寫；可參考 kb-template/global-CLAUDE.md 手動合併。');
  } else if (await choose(options.globalClaudeMd, '建立 Claude Code 全域 CLAUDE.md？', options, prompt)) {
    const source = fs.readFileSync(path.join(templateRoot, 'global-CLAUDE.md'), 'utf8');
    writer.write(globalClaude, replacePlaceholders(source, replacements));
  }

  if (codexAvailable) {
    const codexAgents = path.join(codexHome, 'AGENTS.md');
    if (fs.existsSync(codexAgents)) {
      writer.result.skipped.push(codexAgents);
      output(`略過：${codexAgents}`);
    } else if (await choose('ask', '建立 Codex 全域 AGENTS.md？', options, prompt)) {
      const source = fs.readFileSync(path.join(templateRoot, 'codex', 'AGENTS.md'), 'utf8');
      writer.write(codexAgents, replacePlaceholders(source, replacements));
    }
  }

  writer.write(
    path.join(repoRoot, 'alice.local.json'),
    `${JSON.stringify({
      knowledgeBase: {
        path: slash(kb),
        summaryPage: 'wiki/AI 協作/艾莉絲摘要.md',
        rolesDir: 'wiki/AI 協作/角色',
      },
      codex: {
        available: codexAvailable,
      },
      // §91：允許 GitHub Pages 上的網頁版 Studio 連到這台的 Core（還是要 token 才能用）；不想用就刪掉。
      remoteOrigins: [HOSTED_STUDIO_ORIGIN],
      // 先放知識庫管理員一個角色，Core 才會啟用知識庫摘要與部下；其他專案照 alice.local.example.json 補上。
      projects: [
        { name: '知識庫', path: slash(kb), role: '知識庫管理員', readDirs: [], session: 'Library' },
      ],
    }, null, 2)}\n`,
  );

  const verb = options.dryRun ? '預計新建' : '新建';
  output(`\n${verb} ${writer.result.created.length} 個、略過 ${writer.result.skipped.length} 個`);
  if (!codexAvailable) {
    output('未偵測到 Codex：所有工作由 Claude Code 執行；之後安裝 Codex 可重跑 `node scripts/setup-kb.cjs --codex yes` 補裝（已存在的檔案不會被覆蓋）');
  }
  if (writer.result.skipped.length) {
    output('略過清單：');
    for (const file of writer.result.skipped) output(`- ${file}`);
  }
  output('\n下一步：');
  output('1. 用 Obsidian 開啟 vault。');
  output('2. 在 Claude Code 用 /kb 查詢。');
  output('3. 依〈新增專案指南〉分析第一個專案。');
  output('4. 填寫全域 CLAUDE.md 的留白。');
  return writer.result;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`設定失敗：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  EMPTY_VAULT_DIRS,
  detectCodex,
  main,
  parseArgs,
  replacePlaceholders,
};
