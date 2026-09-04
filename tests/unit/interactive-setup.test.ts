import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';

const { question } = vi.hoisted(() => ({
  question: vi.fn<(prompt: string) => Promise<string>>(),
}));
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question, close: () => {} }),
}));

let directory: string;
let database: string;
let home: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-interactive-'));
  home = path.join(directory, 'home');
  database = path.join(directory, 'crm.db');
  for (const host of ['.pi', '.claude', '.hermes']) {
    fs.mkdirSync(path.join(home, host), { recursive: true });
  }
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'));
  vi.stubEnv('PATH', '');
  vi.stubGlobal('process', {
    ...process,
    stdin: { isTTY: true },
    stdout: { isTTY: true, write: vi.fn() },
    stderr: { isTTY: true, write: vi.fn() },
  });
  question.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function answerWith(answers: string[]) {
  let index = 0;
  question.mockImplementation(async () => {
    expect(fs.existsSync(database)).toBe(false);
    expect(fs.existsSync(path.join(home, '.agents'))).toBe(false);
    const answer = answers[index++];
    if (answer === undefined) throw new Error('Unexpected setup prompt');
    return answer;
  });
}

function setup(...args: string[]) {
  return buildProgram().parseAsync(['--db', database, 'setup', ...args], { from: 'user' });
}

describe('interactive setup', () => {
  it.each([
    { selection: '', pi: true, hermes: true },
    { selection: 'pi, pi', pi: true, hermes: false },
    { selection: 'none', pi: false, hermes: false },
  ])('applies confirmed selection "$selection"', async ({ selection, pi, hermes }) => {
    answerWith(['yes', selection, 'yes']);
    await setup();
    expect(question.mock.calls.map(([prompt]) => prompt)).toEqual([
      'Create your primary local CRM? [y/N] ',
      'Hosts to enable [pi, hermes; enter to keep, none to skip]: ',
      'Apply these actions? [y/N] ',
    ]);
    expect(fs.existsSync(database)).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents', 'skills', 'agentcrm', 'SKILL.md'))).toBe(pi);
    expect(fs.existsSync(path.join(home, '.hermes', 'skills', 'agentcrm', 'SKILL.md'))).toBe(
      hermes,
    );
    expect(fs.existsSync(path.join(home, '.claude', 'skills'))).toBe(false);
    expect(process.stdout.write).toHaveBeenCalledWith('Created the CRM database.\n');
  });

  it.each([{ answers: [''] }, { answers: ['yes', '', ''] }])(
    'cancels without writes for $answers',
    async ({ answers }) => {
      answerWith(answers);
      await setup();
      expect(question).toHaveBeenCalledTimes(answers.length);
      expect(fs.existsSync(database)).toBe(false);
      expect(fs.existsSync(path.join(home, '.agents'))).toBe(false);
      expect(process.stdout.write).toHaveBeenCalledWith(
        'Setup cancelled. No files were changed.\n',
      );
    },
  );

  it.each(['unknown', 'claude-code'])('rejects interactive selection %s', async (selection) => {
    answerWith(['yes', selection]);
    await expect(setup()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(fs.existsSync(database)).toBe(false);
    expect(fs.existsSync(path.join(home, '.agents'))).toBe(false);
  });

  it('rejects JSON mode on a TTY without prompting or writing prose', async () => {
    await expect(setup('--json')).rejects.toMatchObject({ code: 'SETUP_INTERACTIVE_TTY_REQUIRED' });
    expect(question).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(fs.existsSync(database)).toBe(false);
  });
});
