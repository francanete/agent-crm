import fs from 'node:fs';

const READ_CHUNK_BYTES = 64 * 1024;

export function readBoundedBytes(
  input: string | number,
  maximumBytes: number,
  tooLarge: () => never,
): Buffer {
  const descriptor = typeof input === 'number' ? input : fs.openSync(input, 'r');
  const closeDescriptor = typeof input === 'string';
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (total <= maximumBytes) {
      const remaining = maximumBytes + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
  } finally {
    if (closeDescriptor) fs.closeSync(descriptor);
  }

  if (total > maximumBytes) tooLarge();
  return Buffer.concat(chunks, total);
}
