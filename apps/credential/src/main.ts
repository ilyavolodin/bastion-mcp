#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { openBrowser } from './browser';
import { runCli, verificationMessage } from './cli';
import { resolveServerUrl } from './config';
import { KeyringTokenStore } from './keyring-store';
import { TokenManager } from './token-manager';

const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

const server = (): URL =>
  resolveServerUrl({
    env: process.env,
    readFile: (path) => readFileSync(path, 'utf8'),
    home: homedir(),
  });

const manager = (): TokenManager =>
  new TokenManager({
    server: server(),
    store: new KeyringTokenStore(),
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    prompt: async (authorization) => {
      process.stderr.write(verificationMessage(authorization));
      openBrowser(authorization.verification_uri_complete ?? authorization.verification_uri);
    },
  });

let tokens: TokenManager | undefined;

const code = await runCli(process.argv.slice(2), {
  io: {
    readStdin,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  },
  server,
  getAccessToken: () => {
    tokens ??= manager();
    return tokens.getAccessToken();
  },
});
process.exitCode = code;
