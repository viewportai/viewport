import { getArgs } from './args.js';
import { doctor, status } from './lifecycle-commands.js';
import { start } from '../startup.js';

export async function watch(): Promise<void> {
  const args = getArgs();
  const subcommand = args[1] ?? 'help';

  switch (subcommand) {
    case 'help':
    case '--help':
    case '-h':
      showWatchHelp();
      return;
    case 'start':
      await start();
      return;
    case 'doctor':
      await doctor();
      return;
    case 'status':
      await status();
      return;
    default:
      throw new Error(`${watchHelpText()}\nUnknown watch command "${subcommand}".`);
  }
}

export function showWatchHelp(): void {
  console.log(watchHelpText());
}

function watchHelpText(): string {
  return [
    'Usage: vpd watch <command>',
    '',
    'Commands:',
    '  start [vpd start flags...]   Start the personal/local monitor',
    '  doctor [--json]              Diagnose monitor prerequisites',
    '  status [--json]              Show monitor status',
    '  help',
    '',
    'Worker automation uses `vpd worker ...`; watch mode is for personal session monitoring.',
  ].join('\n');
}
