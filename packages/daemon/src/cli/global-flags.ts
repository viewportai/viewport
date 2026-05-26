export function resolveGlobalFlag(args: string[]): 'help' | 'version' | null {
  const first = args[0];
  if (first === '--help' || first === '-h') return 'help';
  if (first === '--version' || first === '-v') return 'version';
  return null;
}
