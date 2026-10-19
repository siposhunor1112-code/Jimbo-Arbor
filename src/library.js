import fs from 'node:fs';
import path from 'node:path';

// Template files live outside any public folder; they are only ever streamed
// through the member-checked download route.
export function createLibrary(db, filesDir) {
  fs.mkdirSync(filesDir, { recursive: true });

  const insert = db.prepare(`
    INSERT INTO templates (title, description, category, month, file_key, original_name, size_bytes, link_url, preview_key, preview_mime)
    VALUES (@title, @description, @category, @month, @fileKey, @originalName, @sizeBytes, @linkUrl, @previewKey, @previewMime)`);
  const byId = db.prepare('SELECT * FROM templates WHERE id = ?');
  const remove = db.prepare('DELETE FROM templates WHERE id = ?');
  const months = db.prepare('SELECT DISTINCT month FROM templates ORDER BY month DESC');
  const categories = db.prepare('SELECT DISTINCT category FROM templates ORDER BY category');
  const list = db.prepare(`
    SELECT * FROM templates
    WHERE (@month IS NULL OR month = @month) AND (@category IS NULL OR category = @category)
    ORDER BY month DESC, id DESC`);

  const filePath = (key) => path.join(filesDir, key);
  const deleteFile = (key) => {
    if (key) fs.rmSync(filePath(key), { force: true });
  };

  return {
    filePath,
    deleteFile,
    list: ({ month = null, category = null } = {}) => list.all({ month, category }),
    months: () => months.all().map((r) => r.month),
    categories: () => categories.all().map((r) => r.category),
    get: (id) => byId.get(id) ?? null,
    add(template) {
      return insert.run(template).lastInsertRowid;
    },
    remove(id) {
      const template = byId.get(id);
      if (!template) return false;
      remove.run(id);
      deleteFile(template.file_key);
      deleteFile(template.preview_key);
      return true;
    },
  };
}
