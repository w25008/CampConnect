import { supabase } from './lib/supabase.js';

// Storage buckets created by supabase/migrations/0005_images.sql.
export const AVATAR_BUCKET = 'avatars';
export const POST_IMAGE_BUCKET = 'post-images';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export const isImageFile = file => !!file && IMAGE_TYPES.includes(file.type);

export function publicUrl(bucket, path) {
  return path ? supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl : '';
}

// Shrink (and for avatars, centre-crop to a square) before uploading, so pictures
// load fast and stay well under the storage limits. Output is always JPEG.
export async function shrinkImage(file, maxSize, square = false) {
  const bitmap = await createImageBitmap(file);
  let sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height;
  if (square) {
    const side = Math.min(sw, sh);
    sx = (sw - side) / 2; sy = (sh - side) / 2; sw = sh = side;
  }
  const scale = Math.min(1, maxSize / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // JPEG has no transparency
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Could not process the image.'))), 'image/jpeg', 0.85));
}

// Uploads into <bucket>/<userId>/<timestamp>.jpg and returns the stored path.
// A new name each time means browsers never show an old cached photo.
export async function uploadImage(bucket, userId, blob) {
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const { error } = await supabase.storage.from(bucket).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' });
  if (error) throw error;
  return path;
}

export async function removeImage(bucket, path) {
  return removeImages(bucket, path ? [path] : []);
}

export async function removeImages(bucket, paths) {
  if (!paths?.length) return;
  const { error } = await supabase.storage.from(bucket).remove(paths);
  if (error) throw error;
}

// A post's images: the list from 0006, or the single image older posts have.
export const postImagePaths = post => (post?.image_paths?.length ? post.image_paths : post?.image_path ? [post.image_path] : []);
