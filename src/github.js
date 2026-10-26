// Small helpers for the GitHub Actions runtime, so the action needs no dependencies.

import { appendFileSync } from 'node:fs';

export function getInput(name, env = process.env) {
  return (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
}

export function setOutput(name, value, env = process.env) {
  const line = `${name}=${String(value).replace(/\r?\n/g, ' ')}\n`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, line);
  else process.stdout.write(`[output] ${line}`);
}

export function mask(value) {
  if (value) console.log(`::add-mask::${value}`);
}

export function info(message) {
  console.log(message);
}

export function notice(message) {
  console.log(`::notice::${escape(message)}`);
}

export function warning(message) {
  console.log(`::warning::${escape(message)}`);
}

export function error(message) {
  console.log(`::error::${escape(message)}`);
}

function escape(message) {
  return String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
