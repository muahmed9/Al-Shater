import { sb }    from '../core/supabase.js';
import { getExt, isAllowedFile, formatFileSize, uid } from '../core/utils.js';

const BUCKET = 'order-files';
const MAX_MB  = 50;
const MAX_B   = MAX_MB * 1024 * 1024;

export async function uploadFile(file, userId, onProgress) {
  if (!isAllowedFile(file)) throw new Error(`نوع الملف غير مدعوم: .${getExt(file.name)}`);
  if (file.size > MAX_B)    throw new Error(`حجم الملف يتجاوز ${MAX_MB}MB (الحجم: ${formatFileSize(file.size)})`);
  await _validateMagicBytes(file);
  const ext  = getExt(file.name);
  const path = `${userId}/${Date.now()}_${uid()}.${ext}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, file, { cacheControl: '3600', upsert: false });
  if (error) throw new Error('فشل رفع الملف: ' + error.message);
  const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
  onProgress?.(100);
  return data.publicUrl;
}

export async function deleteFile(publicUrl) {
  try {
    const url  = new URL(publicUrl);
    const path = url.pathname.split(`/${BUCKET}/`)[1];
    if (!path) return;
    await sb.storage.from(BUCKET).remove([path]);
  } catch(e) { console.warn('[upload] فشل حذف الملف:', e.message); }
}

const MAGIC = {
  pdf:  [[0x25,0x50,0x44,0x46]],
  docx: [[0x50,0x4B,0x03,0x04]],
  pptx: [[0x50,0x4B,0x03,0x04]],
  xlsx: [[0x50,0x4B,0x03,0x04]],
  doc:  [[0xD0,0xCF,0x11,0xE0]],
  jpg:  [[0xFF,0xD8,0xFF]],
  jpeg: [[0xFF,0xD8,0xFF]],
  png:  [[0x89,0x50,0x4E,0x47]],
  webp: [[0x52,0x49,0x46,0x46]],
};

async function _validateMagicBytes(file) {
  const ext      = getExt(file.name);
  const expected = MAGIC[ext];
  if (!expected) return;
  const buf  = await file.slice(0, 8).arrayBuffer();
  const view = new Uint8Array(buf);
  const valid = expected.some(sig => sig.every((byte, i) => view[i] === byte));
  if (!valid) throw new Error(`محتوى الملف لا يطابق امتداده (.${ext}) — ملف مشبوه`);
}
