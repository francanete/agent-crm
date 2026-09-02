import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readBoundedBytes } from '../../src/core/bounded-input.js';

describe('bounded input', () => {
  it('stops reading after one byte beyond the configured limit', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-bounded-input-'));
    const input = path.join(directory, 'large-input');
    fs.writeFileSync(input, Buffer.alloc(1024, 1));
    const readSpy = vi.spyOn(fs, 'readSync');

    try {
      expect(() =>
        readBoundedBytes(input, 10, () => {
          throw new Error('too large');
        }),
      ).toThrow('too large');
      const requestedBytes = readSpy.mock.calls.reduce((total, call) => {
        const positionalCall = call as unknown as [number, Buffer, number, number, null];
        return total + positionalCall[3];
      }, 0);
      expect(requestedBytes).toBe(11);
    } finally {
      readSpy.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
