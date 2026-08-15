#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_DEVICE_NAME = process.env.IOS_SIM_DEVICE || 'iPhone 16 Pro';
const DEFAULT_SCREENSHOT = '/private/tmp/immich-ios-simulator.png';

const usage = `Usage:
  node tools/ios-simulator-control.mjs list
  node tools/ios-simulator-control.mjs boot [device-name-or-udid]
  node tools/ios-simulator-control.mjs screenshot [output.png] [device-name-or-udid]
  node tools/ios-simulator-control.mjs install <app-path> [device-name-or-udid]
  node tools/ios-simulator-control.mjs launch <bundle-id> [device-name-or-udid]
  node tools/ios-simulator-control.mjs open-url <url> [device-name-or-udid]
  node tools/ios-simulator-control.mjs logs <predicate> [device-name-or-udid]

Defaults:
  device-name-or-udid: IOS_SIM_DEVICE or "${DEFAULT_DEVICE_NAME}"
  screenshot path: ${DEFAULT_SCREENSHOT}
`;

const run = (args, options = {}) => {
  const result = spawnSync('xcrun', ['simctl', ...args], {
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error([`xcrun simctl ${args.join(' ')} failed`, stderr, stdout].filter(Boolean).join('\n'));
  }

  return result.stdout ?? '';
};

const listDevices = () => JSON.parse(run(['list', 'devices', 'available', '--json'])).devices;

const resolveDevice = (nameOrUdid = DEFAULT_DEVICE_NAME) => {
  const devicesByRuntime = listDevices();
  const devices = Object.values(devicesByRuntime).flat();
  const exact = devices.find((device) => device.udid === nameOrUdid);
  if (exact) {
    return exact;
  }

  const named = devices.find((device) => device.name === nameOrUdid);
  if (named) {
    return named;
  }

  const available = devices.map((device) => `${device.name} (${device.udid})`).join('\n  ');
  throw new Error(`No available simulator matched "${nameOrUdid}". Available:\n  ${available}`);
};

const bootDevice = (nameOrUdid) => {
  const device = resolveDevice(nameOrUdid);
  if (device.state !== 'Booted') {
    run(['boot', device.udid]);
  }
  run(['bootstatus', device.udid, '-b'], { stdio: 'inherit' });
  return device.udid;
};

const command = process.argv[2];

try {
  switch (command) {
    case 'list': {
      const devices = Object.values(listDevices())
        .flat()
        .map(({ name, udid, state, availabilityError }) => ({ name, udid, state, availabilityError }));
      console.log(JSON.stringify(devices, null, 2));
      break;
    }

    case 'boot': {
      const udid = bootDevice(process.argv[3]);
      console.log(udid);
      break;
    }

    case 'screenshot': {
      const output = resolve(process.argv[3] ?? DEFAULT_SCREENSHOT);
      const udid = bootDevice(process.argv[4]);
      mkdirSync(dirname(output), { recursive: true });
      run(['io', udid, 'screenshot', output], { stdio: 'inherit' });
      console.log(output);
      break;
    }

    case 'install': {
      const appPath = process.argv[3];
      if (!appPath) {
        throw new Error('Missing app path');
      }
      const udid = bootDevice(process.argv[4]);
      run(['install', udid, appPath], { stdio: 'inherit' });
      break;
    }

    case 'launch': {
      const bundleId = process.argv[3];
      if (!bundleId) {
        throw new Error('Missing bundle id');
      }
      const udid = bootDevice(process.argv[4]);
      run(['launch', udid, bundleId], { stdio: 'inherit' });
      break;
    }

    case 'open-url': {
      const url = process.argv[3];
      if (!url) {
        throw new Error('Missing URL');
      }
      const udid = bootDevice(process.argv[4]);
      run(['openurl', udid, url], { stdio: 'inherit' });
      break;
    }

    case 'logs': {
      const predicate = process.argv[3] ?? 'processImagePath CONTAINS "Runner"';
      const udid = bootDevice(process.argv[4]);
      run(['spawn', udid, 'log', 'stream', '--style', 'compact', '--predicate', predicate], { stdio: 'inherit' });
      break;
    }

    default:
      console.error(usage);
      process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
