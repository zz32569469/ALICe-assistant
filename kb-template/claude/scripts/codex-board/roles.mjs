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

export function findRoleForDirectory(cwd, roles) {
  if (typeof cwd !== 'string' || !cwd) return '';
  const folders = cwd.split(/[\\/]+/).filter(Boolean);
  const hit = roles.find(entry =>
    folders.some(folder => folder.localeCompare(entry.folder, undefined, { sensitivity: 'accent' }) === 0)
  );
  return hit ? hit.role : '';
}
