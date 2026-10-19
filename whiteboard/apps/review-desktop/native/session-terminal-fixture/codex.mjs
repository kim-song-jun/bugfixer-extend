#!/usr/bin/env node
import process from 'node:process';

const authEnvironmentNames = [
  'OPENAI_API_KEY', 'OPENAI_ACCESS_TOKEN', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_AUTH_TOKEN',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_API_KEY',
];
const presentAuthNames = authEnvironmentNames.filter(name => Object.hasOwn(process.env, name));
if (presentAuthNames.length) {
  process.stderr.write(`FIXTURE_REFUSED_AUTH_ENV ${presentAuthNames.join(',')}\n`);
  process.exit(70);
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('codex 0.0.0-ci-fixture\n');
  process.exit(0);
}
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write([
    'Codex CI terminal fixture (no provider implementation)',
    'Usage: codex [--no-daemon] --model MODEL --cd DIR --sandbox MODE --ask-for-approval MODE -c KEY=VALUE',
    '       codex resume <SESSION_ID> --no-daemon --model MODEL --cd DIR --sandbox MODE --ask-for-approval MODE -c KEY=VALUE',
  ].join('\n') + '\n');
  process.exit(0);
}
if (args.length === 2 && args[0] === 'resume' && args[1] === '--help') {
  process.stdout.write('Usage: codex resume <SESSION_ID> [--no-daemon] --model MODEL --cd DIR --sandbox MODE --ask-for-approval MODE -c KEY=VALUE\n');
  process.exit(0);
}

// The app's selected-Codex command contract must be present. Hook/MCP config arguments
// are deliberately accepted as inert strings: this fixture never executes either hook
// or gateway and never reads, prints, or stores their credentials/nonce.
const has = flag => args.includes(flag);
const hasValue = flag => args.some((value, index) => value === flag && typeof args[index + 1] === 'string' && !args[index + 1].startsWith('--'));
const valueAfter = flag => args[args.indexOf(flag) + 1];
const isResume = args[0] === 'resume' && Boolean(args[1]) && args[1] !== '--help';
if (!has('--no-daemon') || !hasValue('--model') || !(hasValue('--cd') || hasValue('-C'))
  || !/^ci-fixture-codex-session-[ab]$/.test(valueAfter('--model'))
  || !hasValue('--sandbox') || !hasValue('--ask-for-approval')
  || valueAfter('--sandbox') !== 'read-only' || valueAfter('--ask-for-approval') !== 'never'
  || !(has('-c') || has('--config')) || (args[0] === 'resume' && !isResume)) {
  process.stderr.write('FIXTURE_REFUSED_UNRECOGNIZED_COMMAND_CONTRACT\n');
  process.exit(64);
}

let line = '';
let ended = false;
process.stdout.write(`READY pid=${process.pid} fixtureOnly=true\r\n`);
process.stdout.write(`SIZE cols=${process.stdout.columns ?? 0} rows=${process.stdout.rows ?? 0}\r\n`);

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  for (const character of chunk) {
    if (character === '\r' || character === '\n') {
      if (line.length) process.stdout.write(`ECHO ${line}\r\n`);
      line = '';
    } else if (line.length < 512) {
      line += character;
    }
  }
});

process.on('SIGWINCH', () => {
  process.stdout.write(`SIZE cols=${process.stdout.columns ?? 0} rows=${process.stdout.rows ?? 0}\r\n`);
});
process.on('SIGINT', () => finish(130));
process.on('SIGTERM', () => finish(143));
process.stdin.on('end', () => finish(0));

function finish(code) {
  if (ended) return;
  ended = true;
  process.stdin.pause();
  process.exit(code);
}
