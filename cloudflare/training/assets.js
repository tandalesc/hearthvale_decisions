// Bounded streaming transport for private training assets. Checksums identify
// bytes stored in R2; gzip expands only after the downloaded checksum verifies.
import {createReadStream, createWriteStream} from 'node:fs';
import {mkdir, rename, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip, createGunzip} from 'node:zlib';
export const MAX_ASSET_UPLOAD_BYTES = 300 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
function meter(max, hash) {
  let bytes = 0;
  const stream = new Transform({transform(chunk, encoding, callback) {
    bytes += chunk.byteLength;
    if (bytes > max) { callback(new Error(`Training asset exceeds ${max} byte limit`)); return; }
    hash?.update(chunk); callback(null, chunk);
  }});
  stream.byteCount = () => bytes;
  return stream;
}
export async function packBootstrapAsset(source, directory, {gzip = source.endsWith('.jsonl')} = {}) {
  await mkdir(directory, {recursive: true});
  const temporary = join(directory, `.packing-${randomUUID()}`), hash = createHash('sha256'), bounded = meter(MAX_ASSET_UPLOAD_BYTES, hash);
  try {
    await pipeline(createReadStream(source), ...(gzip ? [createGzip({level: 6})] : []), bounded, createWriteStream(temporary, {flags: 'wx'}));
    const sha256 = hash.digest('hex'); await rename(temporary, join(directory, sha256));
    return {sha256, bytes: bounded.byteCount(), ...(gzip ? {encoding: 'gzip'} : {})};
  } finally { await rm(temporary, {force: true}); }
}
export async function saveTrainingAsset(response, asset, destination) {
  if (asset.encoding !== undefined && asset.encoding !== 'gzip') throw new Error('Unsupported training asset encoding');
  if (asset.encoding === 'gzip' && !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '')) throw new Error('Compressed asset requires checksum');
  await mkdir(dirname(destination), {recursive: true});
  const temporary = `${destination}.download-${randomUUID()}`, expanded = `${destination}.expanded-${randomUUID()}`;
  const hash = createHash('sha256'), bounded = meter(MAX_ASSET_UPLOAD_BYTES, hash);
  try {
    await pipeline(Readable.fromWeb(response.body), bounded, createWriteStream(temporary, {flags: 'wx'}));
    const sha256 = hash.digest('hex');
    if (asset.sha256 && sha256 !== asset.sha256) throw new Error('Asset checksum mismatch');
    if (asset.encoding === 'gzip') {
      await pipeline(createReadStream(temporary), createGunzip(), meter(MAX_EXPANDED_BYTES), createWriteStream(expanded, {flags: 'wx'}));
      await rename(expanded, destination);
    } else await rename(temporary, destination);
    return {sha256, bytes: bounded.byteCount()};
  } finally { await Promise.all([rm(temporary, {force: true}), rm(expanded, {force: true})]); }
}
