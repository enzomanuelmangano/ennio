#!/usr/bin/env bun
/**
 * One-shot step runner. Sends a single Ennio command to the running app
 * and prints the result. Useful when manually walking a flow alongside
 * `ennio hierarchy` to find the right testID / selector / button label.
 *
 * Usage:
 *   bun scripts/step.ts tap <id>
 *   bun scripts/step.ts tap-text "<text>"
 *   bun scripts/step.ts input "<text>"
 *   bun scripts/step.ts exists <id>
 *   bun scripts/step.ts visible <id>
 *   bun scripts/step.ts visible-text "<text>"
 *   bun scripts/step.ts text <id>
 *   bun scripts/step.ts alert
 *   bun scripts/step.ts buttons
 *   bun scripts/step.ts alert-tap "<text>"
 *   bun scripts/step.ts scroll <up|down|left|right> [px]
 *   bun scripts/step.ts scroll-id <id> <up|down|left|right> [px]
 *   bun scripts/step.ts press <key>
 *   bun scripts/step.ts hide-kbd
 *   bun scripts/step.ts focus <id>            (tap to focus a TextInput)
 *   bun scripts/step.ts type-into <id> "<text>"
 *   bun scripts/step.ts raw '<json>'           (type+payload)
 */
import { EnnioClient } from '../packages/cli/src/client';
import { NitroWriter } from '../packages/cli/src/writer';

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('usage: bun scripts/step.ts <cmd> [args...]');
  process.exit(2);
}
const [cmd, ...rest] = argv;
const arg = rest.join(' ');

const client = new EnnioClient(9876);
await client.connect();
const writer = new NitroWriter(client);

try {
  switch (cmd) {
    case 'tap':
      console.log(await writer.tap(arg));
      break;
    case 'tap-text':
      console.log(await writer.tapBySelector({ text: { pattern: arg, mode: 'contains' } }));
      break;
    case 'input':
      console.log(await writer.typeTextBySelector({ focused: true }, arg));
      break;
    case 'type-into': {
      const [id, ...txtParts] = rest;
      const txt = txtParts.join(' ');
      console.log(await writer.typeText(id, txt));
      break;
    }
    case 'focus':
      console.log(await writer.tap(arg));
      break;
    case 'clear':
      console.log(await writer.clearText(arg));
      break;
    case 'exists':
      console.log(await client.exists(arg));
      break;
    case 'visible':
      console.log(await client.isVisible(arg));
      break;
    case 'visible-text':
      console.log(await client.isVisibleBySelector({ text: { pattern: arg, mode: 'contains' } }));
      break;
    case 'text':
      console.log(JSON.stringify(await client.getText(arg)));
      break;
    case 'alert':
      console.log(await client.isAlertPresent());
      break;
    case 'buttons':
      console.log(JSON.stringify(await client.getAlertButtons()));
      break;
    case 'alert-tap':
      console.log(await writer.tapAlertButton(arg));
      break;
    case 'scroll': {
      const [dir, px] = rest;
      const candidates = ['scroll-view', 'flatlist', 'profile-screen', 'products-list', 'cart-items-list', 'orders-list', 'settings-screen', 'cart-screen'];
      const direction = dir as 'up' | 'down' | 'left' | 'right';
      let done = false;
      for (const id of candidates) {
        if (await client.exists(id)) {
          console.log(await writer.scroll(id, direction, parseInt(px || '300', 10)), 'via', id);
          done = true;
          break;
        }
      }
      if (!done) console.log('no scrollable container in tree');
      break;
    }
    case 'scroll-id': {
      const [id, dir, px] = rest;
      const direction = dir as 'up' | 'down' | 'left' | 'right';
      console.log(await writer.scroll(id, direction, parseInt(px || '300', 10)));
      break;
    }
    case 'press':
      console.log(await writer.pressKey(null, arg));
      break;
    case 'hide-kbd':
      console.log(await writer.hideKeyboard());
      break;
    case 'raw': {
      const obj = JSON.parse(arg);
      const res = await client.send(obj.type, obj.payload || {});
      console.log(JSON.stringify(res));
      break;
    }
    default:
      console.error(`unknown cmd: ${cmd}`);
      process.exit(2);
  }
} finally {
  client.disconnect();
}
