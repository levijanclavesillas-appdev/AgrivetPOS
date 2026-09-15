// A product's picture, on any screen that shows one — TASK-052, IMG-001.
//
// **Shown from a blob, never from a link.** SEC-7 keeps the session token in memory, so
// an `<img src="/api/v1/…">` would arrive without it and be refused. Each picture is
// fetched with the token, once, and kept as an object URL keyed by product, version and
// size; the version is in the key, so a replaced picture is simply a new entry. The
// cache is bounded, and what falls out of it is revoked, because a counter that runs
// all day would otherwise hold every thumbnail it ever showed.
//
// **Shrunk here, before it is sent.** The server has no image library (902_product_images
// .sql says why), and a phone's photo is several megabytes. A canvas makes the two sizes
// IMG-001 accepts — 640 px on the long side, and 128 px for lists — as JPEG on white, so
// a transparent PNG does not turn black on the way.

import * as api from './api.js';
import { h } from './ui.js';
import { icon } from './icons.js';

const SIZES = Object.freeze({ image: 640, thumb: 128 });
const LIMITS = Object.freeze({ image: 600 * 1024, thumb: 64 * 1024 });
const MAX_CACHED = 400;

const cache = new Map();      // key → Promise<string|null> (an object URL, or null for none)

function remember(key, promise) {
  cache.set(key, promise);
  while (cache.size > MAX_CACHED) {
    const [oldest, entry] = cache.entries().next().value;
    cache.delete(oldest);
    entry.then((url) => { if (url) URL.revokeObjectURL(url); });
  }
  return promise;
}

/** The object URL for one size of a product's picture, or null when it has none. */
export function pictureUrl(productId, version, size = 'thumb') {
  if (!productId || !version) return Promise.resolve(null);
  const key = `${productId}:${version}:${size}`;
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);          // most recently used goes to the end
    cache.set(key, hit);
    return hit;
  }
  const query = size === 'thumb' ? `?size=thumb&v=${version}` : `?v=${version}`;
  // A miss is not remembered: a fetch that failed once is asked again the next time the
  // row is drawn, rather than leaving that product blank until the app is reloaded.
  return remember(key, api.blob(`/products/${productId}/image${query}`)
    .then((blob) => (blob ? URL.createObjectURL(blob) : null))
    .catch(() => null)
    .then((url) => { if (!url && cache.get(key)) cache.delete(key); return url; }));
}

/**
 * The picture as an element: a frame that shows the picture when it arrives, or a pill
 * where there is none. The frame is the size either way, so a list does not jump as
 * its pictures load.
 */
/** TASK-066: the mark of a product with no picture is the store's — a cup in a café. */
let emptyIcon = 'pill';
export function setEmptyIcon(name) { emptyIcon = name || 'pill'; }

export function productPicture(product, { size = 'thumb', className = 'product-picture' } = {}) {
  const frame = h('span', { class: `${className} is-empty`, 'aria-hidden': 'true' }, [icon(emptyIcon)]);
  const version = product && product.image_version;
  if (!version) return frame;
  pictureUrl(product.id, version, size).then((url) => {
    if (!url) return;
    const img = h('img', { src: url, alt: '', decoding: 'async', draggable: 'false' });
    frame.classList.remove('is-empty');
    frame.replaceChildren(img);
  });
  return frame;
}

/**
 * Ask for a picture: a file on a PC; on Android, the camera or the gallery (the app's
 * file chooser offers both for `image/*`). Resolves with the File, or null if nothing
 * was chosen.
 */
export function choosePicture() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
    const done = (file) => { resolve(file); input.remove(); };
    input.addEventListener('change', () => done(input.files && input.files[0] ? input.files[0] : null), { once: true });
    // Dismissed without a choice. Not guessed from the window's focus coming back: on
    // Android the camera hands its photo over after the app is already in front again.
    input.addEventListener('cancel', () => done(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

async function decode(file) {
  if (!file || !/^image\//.test(file.type || 'image/')) {
    throw new Error('That file is not a picture. Choose a photo, a JPEG or a PNG.');
  }
  // createImageBitmap applies the photo's own orientation, so a phone held upright
  // gives an upright picture.
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('That picture could not be opened. Choose a JPEG or PNG photo.');
  }
}

function draw(bitmap, longSide) {
  const scale = Math.min(1, longSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const toBlob = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

async function encode(canvas, limit) {
  for (const quality of [0.85, 0.75, 0.6, 0.45]) {
    const blob = await toBlob(canvas, quality);
    if (blob && blob.size <= limit) return blob;
  }
  throw new Error('That picture is too detailed to save small enough. Try a closer, plainer photo.');
}

const base64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

/** The two sizes IMG-001 accepts, ready to PUT, and a preview URL for the editor. */
export async function shrink(file) {
  const bitmap = await decode(file);
  try {
    const image = await encode(draw(bitmap, SIZES.image), LIMITS.image);
    const thumb = await encode(draw(bitmap, SIZES.thumb), LIMITS.thumb);
    return { image: await base64(image), thumb: await base64(thumb), preview: URL.createObjectURL(image) };
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

/** Save a shrunk picture to a product. Returns the product's new image version. */
export async function upload(productId, shrunk) {
  const { image } = await api.put(`/products/${productId}/image`, { image: shrunk.image, thumb: shrunk.thumb });
  return image ? image.version : null;
}

export const remove = (productId) => api.del(`/products/${productId}/image`);
