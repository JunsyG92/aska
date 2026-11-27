#!/usr/bin/env node
// Fake GitHub CLI for the tests: logs its arguments, stdin and folder, then
// prints the URL of a pull request, as "gh pr create" does.
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  if (process.env.FAKE_GH_LOG) {
    require('fs').appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, stdin, cwd: process.cwd() }) + '\n');
  }
  if (args[0] === 'pr' && args[1] === 'create') {
    process.stdout.write('\nCreating pull request for aska into main\n\nhttps://github.com/example/web/pull/7\n');
    return;
  }
  process.stderr.write('fake gh: unknown command\n');
  process.exit(1);
});
