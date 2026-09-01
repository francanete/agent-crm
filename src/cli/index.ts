import { runCli } from './program.js';

const exitCode = await runCli(process.argv.slice(2));
process.exitCode = exitCode;
