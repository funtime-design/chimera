import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Owner addresses are private inputs, never fixture literals. Match the existing .dev.vars harness format.
export function ownerEmails(root, owner, other) {
  let members = {};
  try {
    const line = readFileSync(join(root, '.dev.vars'), 'utf8').split('\n').find(line => line.startsWith('GOONBRIDGE_MEMBERS='));
    if (line) members = JSON.parse(line.slice('GOONBRIDGE_MEMBERS='.length).replace(/^'(.*)'$/, '$1'));
  } catch { /* Tests without owner OAuth inputs do not use these roles. */ }
  const email = member => Object.entries(members).find(([, name]) => name === member)?.[0];
  return { owner: email(owner), other: email(other) };
}
