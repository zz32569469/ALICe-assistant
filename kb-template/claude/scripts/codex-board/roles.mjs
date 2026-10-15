import fs from 'node:fs';

export function readRoles(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(value)) return [];
    return value.filter(entry =>
      entry && typeof entry.folder === 'string' && entry.folder &&
      typeof entry.role === 'string' && entry.role
    );
  } catch {
    return [];
  }
}

/** 工作目錄的任一層是設定的資料夾，或是「<資料夾>-<名稱>」（手動 worktree，例 my-repo-feature）就算。 */
export function findRoleForDirectory(cwd, roles) {
  if (typeof cwd !== 'string' || !cwd) return '';
  const folders = cwd.split(/[\\/]+/).filter(Boolean).map(folder => folder.toLowerCase());
  const hit = roles.find(entry => {
    const name = entry.folder.toLowerCase();
    return folders.some(folder => folder === name || folder.startsWith(`${name}-`));
  });
  return hit ? hit.role : '';
}
