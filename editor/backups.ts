import type { Document } from './workspace.ts';
export type Backup = { id: string; updatedAt: string; document: Document };
export const backupPrefix = (repository: string) =>
  `wiki-studio:${repository}:`;
export function saveBackup(
  storage: Storage,
  repository: string,
  backup: Backup,
) {
  // Each page owns its own entry. A clean page never deletes another page's work.
  storage.setItem(backupPrefix(repository) + backup.id, JSON.stringify(backup));
}
export function readBackups(storage: Storage, repository: string): Backup[] {
  const items: Backup[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(backupPrefix(repository))) continue;
    try {
      const entry = JSON.parse(storage.getItem(key) || 'null') as Backup;
      if (
        entry &&
        typeof entry.id === 'string' &&
        typeof entry.updatedAt === 'string' &&
        typeof entry.document?.article?.content === 'string'
      )
        items.push(entry);
    } catch {
      /* A broken entry should not hide the remaining recoverable drafts. */
    }
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function removeBackup(
  storage: Storage,
  repository: string,
  ownId: string,
) {
  storage.removeItem(backupPrefix(repository) + ownId);
}
