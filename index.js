#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { accessSync, constants, existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = '8899';
const SAFE_EXEC_PATH = '/usr/sbin:/usr/bin:/bin:/sbin';
const HELP_COMMANDS = new Set(['help', '--help', '-h']);
const VALID_COMMANDS = new Set(['on', 'off', 'toggle', 'status', 'list', 'reset-bypass']);
const DEFAULT_BYPASS_DOMAINS = [
  '127.0.0.1',
  '192.168.0.0/16',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '172.29.0.0/16',
  'localhost',
  '*.local',
  '<local>'
];
const PENDING_STATE_FILE = path.join(
  os.tmpdir(),
  `proxy-toggle-pending-${typeof process.getuid === 'function' ? process.getuid() : 'user'}.json`
);

const NETWORKSETUP_BIN = resolveBinary('networksetup', ['/usr/sbin/networksetup']);
const ROUTE_BIN = resolveBinary('route', ['/sbin/route']);
const LSOF_BIN = '/usr/sbin/lsof';

// W2 candidates: user-level npm global bin. Falls back gracefully if not found.
const W2_PATHS = (() => {
  const paths = [];
  const npmPrefix = (() => {
    try {
      const r = spawnSync('npm', ['config', 'get', 'prefix'], { encoding: 'utf8', timeout: 3000 });
      if (r.status === 0 && r.stdout) return r.stdout.trim();
    } catch {}
    return null;
  })();
  if (npmPrefix) paths.push(path.join(npmPrefix, 'bin', 'w2'));
  paths.push('/usr/local/bin/w2', '/opt/homebrew/bin/w2');
  return paths;
})();


function findPackageManager() {
  // Prefer pnpm (faster), fall back to npm
  for (const pm of ['pnpm', 'npm']) {
    try {
      const r = spawnSync('which', [pm], { encoding: 'utf8', timeout: 3000 });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    } catch {}
  }
  return null;
}

function installWhistle(pm) {
  console.log(` Installing whistle (via ${path.basename(pm)})...`);
  const result = spawnSync(pm, ['install', '-g', 'whistle'], {
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) return { ok: false, reason: `Failed to run ${pm}: ${result.error.message}` };
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || '').trim();
    return { ok: false, reason: `${path.basename(pm)} install failed${details ? `: ${details}` : ''}` };
  }
  console.log(' Whistle installed');
  return { ok: true };
}

function findW2Binary() {
  for (const candidate of W2_PATHS) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  // Last resort: try the user's full PATH
  try {
    const r = spawnSync('which', ['w2'], { encoding: 'utf8', timeout: 3000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {}
  return null;
}

function resolveBinary(binaryName, candidates) {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`Required binary "${binaryName}" is unavailable. Checked: ${candidates.join(', ')}`);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: SAFE_EXEC_PATH }
  });
  if (result.error) {
    throw new Error(`Failed to run ${command}: ${result.error.message}`);
  }
  const combinedOutput = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status !== 0) {
    const details = combinedOutput.trim();
    throw new Error(`${command} ${args.join(' ')} failed${details ? `: ${details}` : ''}`);
  }
  return combinedOutput;
}

function runNetworksetup(args) {
  const output = runCommand(NETWORKSETUP_BIN, args);
  if (/AuthorizationCreate\(\)\s+failed/i.test(output)) {
    throw new Error(`networksetup ${args.join(' ')} failed: AuthorizationCreate() failed`);
  }
  return output;
}

function hasLocalProxyListener() {
  try {
    accessSync(LSOF_BIN, constants.X_OK);
  } catch {
    return undefined;
  }
  const result = spawnSync(LSOF_BIN, ['-nP', `-iTCP:${PROXY_PORT}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: SAFE_EXEC_PATH }
  });
  if (result.error) {
    return undefined;
  }
  return result.status === 0 && result.stdout.includes(`:${PROXY_PORT}`);
}


function runW2(args) {
  const w2 = findW2Binary();
  if (!w2) return { ok: false, reason: 'w2 binary not found. Install whistle: npm i -g whistle' };
  const result = spawnSync(w2, args, { encoding: 'utf8', timeout: 15000 });
  if (result.error) return { ok: false, reason: `Failed to run w2: ${result.error.message}` };
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || '').trim();
    return { ok: false, reason: `w2 ${args.join(' ')} failed${details ? `: ${details}` : ''}` };
  }
  return { ok: true };
}

// Enable whistle rules via its HTTP API (clears "All rules are currently disabled")
function enableWhistleRules() {
  // Poll until whistle is ready (max 10s), then enable rules
  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      // Wait 1s between retries
      const until = Date.now() + 1000;
      while (Date.now() < until) { /* busy-wait */ }
    }
    try {
      const result = spawnSync('curl', [
        '-s', '-X', 'POST',
        `http://${PROXY_HOST}:${PROXY_PORT}/cgi-bin/rules/disable-all-rules`,
        '--data-urlencode', 'disabledAllRules=0',
        '--connect-timeout', '3', '--max-time', '5',
      ], { encoding: 'utf8', timeout: 8000 });
      if (result.status === 0 && result.stdout.includes('"ec":0')) {
        console.log(' Whistle rules enabled');
        return;
      }
    } catch {}
  }
}

function ensureWhistleRunning() {
  // Try starting if not already listening
  if (hasLocalProxyListener() !== true) {
    let r = runW2(['start', '-p', PROXY_PORT]);
    if (!r.ok) {
      // start failed, try restart in case daemon is in a dead state
      r = runW2(['restart', '-p', PROXY_PORT]);
    }

    // w2 not found? Try auto-install whistle, then start
    if (!r.ok && !findW2Binary()) {
      let installed = false;
      for (const pmName of ['pnpm', 'npm']) {
        const pmPath = (() => {
          try {
            const r = spawnSync('which', [pmName], { encoding: 'utf8', timeout: 3000 });
            if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
          } catch {}
          return null;
        })();
        if (!pmPath) continue;
        const installResult = installWhistle(pmPath);
        if (installResult.ok) {
          installed = true;
          break;
        }
        console.warn(` Warning: ${pmName} install failed (${installResult.reason}), trying next...`);
      }
      if (!installed) {
        console.warn(' Warning: failed to auto-install whistle.');
        console.warn(` Install manually: "npm i -g whistle", then "w2 start -p ${PROXY_PORT}"`);
        return;
      }
      r = runW2(['start', '-p', PROXY_PORT]);
    }

    if (r && r.ok) {
      console.log(` Whistle started on ${PROXY_HOST}:${PROXY_PORT}`);
    } else if (r && !r.ok) {
      console.warn(` Warning: unable to auto-start whistle (${r.reason}).`);
      console.warn(` Start manually: "w2 start -p ${PROXY_PORT}"`);
      return;
    }
  }

  // Enable auto-start on boot + enable rules
  runW2(['enable']);
  enableWhistleRules();
}

function stopWhistleIfRunning() {
  const w2 = findW2Binary();
  if (!w2) return;
  const r = runW2(['stop']);
  if (r.ok) {
    console.log(' Whistle stopped');
  }
}

function normalizeFieldKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseKeyValueOutput(output) {
  const fields = new Map();
  for (const line of output.split('\n')) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    fields.set(normalizeFieldKey(match[1]), match[2].trim());
  }
  return fields;
}

function pickField(fields, keys) {
  for (const key of keys) {
    if (fields.has(key)) {
      return fields.get(key);
    }
  }
  return undefined;
}

function parseBoolean(value) {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (['yes', 'true', '1', 'on'].includes(normalized)) {
    return true;
  }
  if (['no', 'false', '0', 'off'].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseProxyInfo(output) {
  const fields = parseKeyValueOutput(output);
  const enabled = parseBoolean(pickField(fields, ['enabled'])) ?? false;
  const serverRaw = pickField(fields, ['server']);
  const portRaw = pickField(fields, ['port']);
  const port = portRaw && /^\d+$/.test(portRaw) ? portRaw : undefined;
  const server = serverRaw && serverRaw !== '(null)' ? serverRaw : undefined;
  const authenticated =
    parseBoolean(pickField(fields, ['authenticatedproxyenabled', 'authenticationenabled', 'authenticated'])) ?? false;
  const usernameRaw = pickField(fields, ['username', 'user']);
  const passwordRaw = pickField(fields, ['password']);
  const username = usernameRaw && usernameRaw !== '(null)' ? usernameRaw : undefined;
  const password = passwordRaw && passwordRaw !== '(null)' ? passwordRaw : undefined;
  return { enabled, server, port, authenticated, username, password };
}

function listServices() {
  const output = runNetworksetup(['-listallnetworkservices']);
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('*') && !line.startsWith('An asterisk'));
}

function getServiceOrder() {
  const output = runNetworksetup(['-listnetworkserviceorder']);
  const lines = output.split('\n');
  const ordered = [];
  let currentService;
  for (const line of lines) {
    const serviceMatch = line.match(/^\(\d+\)\s+(.+)$/);
    if (serviceMatch) {
      currentService = serviceMatch[1].trim();
      continue;
    }
    const deviceMatch = line.match(/^\(Hardware Port: .*?, Device: (.+?)\)$/);
    if (deviceMatch && currentService) {
      ordered.push({ service: currentService, device: deviceMatch[1].trim() });
      currentService = undefined;
    }
  }
  return ordered;
}

function getDefaultDevice() {
  try {
    const output = runCommand(ROUTE_BIN, ['-n', 'get', 'default']);
    return output.match(/^interface:\s+(\S+)$/m)?.[1];
  } catch {
    return undefined;
  }
}

function getActiveNetworkService(services) {
  const ordered = getServiceOrder();
  const defaultDevice = getDefaultDevice();
  const byDevice = ordered.find(item => item.device === defaultDevice && services.includes(item.service));
  if (byDevice) {
    return byDevice.service;
  }
  const firstKnown = ordered.find(item => services.includes(item.service));
  if (firstKnown) {
    return firstKnown.service;
  }
  return services[0];
}

function getProxyInfo(service, kind) {
  const flag = kind === 'http' ? '-getwebproxy' : '-getsecurewebproxy';
  return parseProxyInfo(runNetworksetup([flag, service]));
}

function getProxyBypassDomains(service) {
  const output = runNetworksetup(['-getproxybypassdomains', service]);
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !/bypass\s+domains:?/i.test(line));
}

function setProxyBypassDomains(service, domains) {
  if (!Array.isArray(domains)) {
    throw new Error('Bypass domains must be an array');
  }
  const sanitizedDomains = domains.map(item => `${item}`.trim()).filter(Boolean);
  const args = ['-setproxybypassdomains', service];
  if (sanitizedDomains.length) {
    args.push(...sanitizedDomains);
  } else {
    args.push('Empty');
  }
  runNetworksetup(args);
}

function getProxySnapshot(service) {
  return {
    http: getProxyInfo(service, 'http'),
    https: getProxyInfo(service, 'https'),
    bypass: getProxyBypassDomains(service)
  };
}

function validateProxyInfo(proxyInfo, label) {
  if (!proxyInfo || typeof proxyInfo !== 'object') {
    throw new Error(`Pending snapshot for ${label} is invalid`);
  }
  if (typeof proxyInfo.enabled !== 'boolean') {
    throw new Error(`Pending snapshot for ${label} has invalid enabled state`);
  }
}

function validateBypassDomains(domains) {
  if (!Array.isArray(domains)) {
    throw new Error('Pending snapshot for bypass domains is invalid');
  }
  for (const entry of domains) {
    if (typeof entry !== 'string') {
      throw new Error('Pending snapshot contains invalid bypass domain entries');
    }
  }
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Pending snapshot is invalid');
  }
  validateProxyInfo(snapshot.http, 'HTTP');
  validateProxyInfo(snapshot.https, 'HTTPS');
  validateBypassDomains(snapshot.bypass);
}

function setProxyConfig(service, kind, proxyInfo) {
  const setProxyFlag = kind === 'http' ? '-setwebproxy' : '-setsecurewebproxy';
  const setStateFlag = kind === 'http' ? '-setwebproxystate' : '-setsecurewebproxystate';
  const label = kind === 'http' ? 'HTTP' : 'HTTPS';

  if (proxyInfo.enabled && (!proxyInfo.server || !proxyInfo.port)) {
    throw new Error(`Cannot restore previous ${label} proxy: missing server/port`);
  }

  if (proxyInfo.server && proxyInfo.port) {
    const args = [setProxyFlag, service, proxyInfo.server, proxyInfo.port];
    if (proxyInfo.authenticated && proxyInfo.username && proxyInfo.password) {
      args.push('on', proxyInfo.username, proxyInfo.password);
    }
    runNetworksetup(args);
  }

  runNetworksetup([setStateFlag, service, proxyInfo.enabled ? 'on' : 'off']);
}

function restoreProxy(service, snapshot) {
  validateSnapshot(snapshot);
  setProxyConfig(service, 'http', snapshot.http);
  setProxyConfig(service, 'https', snapshot.https);
  setProxyBypassDomains(service, snapshot.bypass);
}

function writePendingState(actionName, service, snapshot) {
  const payload = {
    version: 1,
    actionName,
    service,
    createdAt: new Date().toISOString(),
    snapshot
  };
  writeFileSync(PENDING_STATE_FILE, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function readPendingState() {
  if (!existsSync(PENDING_STATE_FILE)) {
    return undefined;
  }
  const raw = readFileSync(PENDING_STATE_FILE, 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object') {
    throw new Error(`Pending recovery file is invalid: ${PENDING_STATE_FILE}`);
  }
  return data;
}

function clearPendingState() {
  if (existsSync(PENDING_STATE_FILE)) {
    unlinkSync(PENDING_STATE_FILE);
  }
}

function recoverPendingStateIfNeeded() {
  const pending = readPendingState();
  if (!pending) {
    return;
  }
  const { actionName, service, snapshot, createdAt } = pending;
  if (typeof service !== 'string' || !service.trim()) {
    throw new Error(`Pending recovery file has invalid service: ${PENDING_STATE_FILE}`);
  }
  console.warn(
    `⚠️  Found unfinished proxy action "${actionName || 'unknown'}" from ${createdAt || 'unknown time'}; restoring previous state on ${service}...`
  );
  restoreProxy(service, snapshot);
  clearPendingState();
  console.warn(`✅ Previous proxy state restored on ${service}.`);
}

function runWithRollback(service, actionName, fn) {
  const snapshot = getProxySnapshot(service);
  writePendingState(actionName, service, snapshot);
  try {
    fn();
    clearPendingState();
  } catch (error) {
    try {
      restoreProxy(service, snapshot);
      clearPendingState();
    } catch (rollbackError) {
      throw new Error(
        `${actionName} failed and rollback also failed: ${error.message}; rollback error: ${rollbackError.message}; recovery file: ${PENDING_STATE_FILE}`
      );
    }
    throw new Error(`${actionName} failed and previous state was restored: ${error.message}`);
  }
}

function enableProxy(service) {
  ensureWhistleRunning();
  runWithRollback(service, 'Enable proxy', () => {
    console.log(` Enabling HTTP proxy on ${service}...`);
    runNetworksetup(['-setwebproxy', service, PROXY_HOST, PROXY_PORT]);
    runNetworksetup(['-setwebproxystate', service, 'on']);
    console.log(` Enabling HTTPS proxy on ${service}...`);
    runNetworksetup(['-setsecurewebproxy', service, PROXY_HOST, PROXY_PORT]);
    runNetworksetup(['-setsecurewebproxystate', service, 'on']);
  });
  console.log(` Proxy enabled on ${service}: ${PROXY_HOST}:${PROXY_PORT} (HTTP + HTTPS)`);
}

function disableProxy(service) {
  runWithRollback(service, 'Disable proxy', () => {
    console.log(` Disabling HTTP proxy on ${service}...`);
    runNetworksetup(['-setwebproxystate', service, 'off']);
    console.log(` Disabling HTTPS proxy on ${service}...`);
    runNetworksetup(['-setsecurewebproxystate', service, 'off']);
    console.log(` Resetting proxy bypass domains on ${service}...`);
    setProxyBypassDomains(service, DEFAULT_BYPASS_DOMAINS);
  });
  console.log(` Proxy disabled on ${service} (HTTP + HTTPS); bypass domains restored to defaults`);
  stopWhistleIfRunning();
}

function resetProxyBypass(service) {
  runWithRollback(service, 'Reset proxy bypass domains', () => {
    console.log(` Resetting proxy bypass domains on ${service}...`);
    setProxyBypassDomains(service, DEFAULT_BYPASS_DOMAINS);
  });
  console.log(' Proxy bypass domains restored to defaults');
}

function formatProxyValue(proxyInfo) {
  if (!proxyInfo.enabled) {
    return 'disabled';
  }
  if (proxyInfo.server && proxyInfo.port) {
    return `${proxyInfo.server}:${proxyInfo.port}`;
  }
  return 'enabled (server/port unavailable)';
}

function status(service, defaulted = false) {
  const http = getProxyInfo(service, 'http');
  const https = getProxyInfo(service, 'https');
  const bothEnabled = http.enabled && https.enabled;
  const anyEnabled = http.enabled || https.enabled;
  const state = bothEnabled ? 'enabled' : anyEnabled ? 'partially enabled' : 'disabled';
  const icon = bothEnabled ? '🟢' : anyEnabled ? '🟡' : '🔴';
  console.log(`${icon} Proxy ${state} on ${defaulted ? 'active service ' : ''}${service}`);
  console.log(`   HTTP:  ${formatProxyValue(http)}`);
  console.log(`   HTTPS: ${formatProxyValue(https)}`);
}

function listAll(services) {
  console.log('Network services:');
  for (const service of services) {
    try {
      const http = getProxyInfo(service, 'http');
      const https = getProxyInfo(service, 'https');
      const bothEnabled = http.enabled && https.enabled;
      const anyEnabled = http.enabled || https.enabled;
      const icon = bothEnabled ? '🟢' : anyEnabled ? '🟡' : '🔴';
      const details = [`HTTP ${formatProxyValue(http)}`, `HTTPS ${formatProxyValue(https)}`].join(', ');
      console.log(`  ${icon} ${service} (${details})`);
    } catch (error) {
      console.log(`  ⚠️ ${service} (failed to read proxy state: ${error.message})`);
    }
  }
}

function printUsage(services = []) {
  console.log('Usage: proxy-toggle <command> [service]');
  console.log('');
  console.log('Commands:');
  console.log('  on              Enable HTTP + HTTPS proxy on active network');
  console.log('  off             Disable HTTP + HTTPS proxy on active network');
  console.log('  toggle          Toggle proxy on active network');
  console.log('  status          Show proxy status');
  console.log('  list            List all network services');
  console.log('  reset-bypass    Restore proxy bypass domains to defaults');
  console.log('');
  console.log('Examples:');
  console.log('  proxy-toggle on               # Enable on active network');
  console.log('  proxy-toggle on "Wi-Fi"        # Enable on Wi-Fi');
  console.log('  proxy-toggle status "Wi-Fi"    # Check Wi-Fi proxy status');
  console.log('  proxy-toggle reset-bypass       # Restore bypass list to defaults');
  console.log('  proxy-toggle reset-bypass "Wi-Fi"  # Restore bypass on Wi-Fi');
  console.log('');
  if (services.length) {
    console.log('');
    console.log('Available services:');
    services.forEach(item => console.log(`  - ${item}`));
  }
}

function validateCliArgs(cmd, args) {
  if (cmd === 'list') {
    if (args.length > 0) {
      throw new Error('Command "list" does not accept a service argument');
    }
    return { serviceArg: undefined };
  }
  if (args.length > 1) {
    throw new Error(`Command "${cmd}" accepts at most one service argument`);
  }
  return { serviceArg: args[0] };
}

function main() {
  const cmd = process.argv[2];
  if (!cmd || HELP_COMMANDS.has(cmd)) {
    printUsage();
    process.exitCode = cmd ? 0 : 1;
    return;
  }
  if (!VALID_COMMANDS.has(cmd)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const { serviceArg } = validateCliArgs(cmd, process.argv.slice(3));

  recoverPendingStateIfNeeded();

  const services = listServices();
  if (!services.length) {
    throw new Error('No network services found');
  }

  const service = cmd === 'list' ? undefined : serviceArg || getActiveNetworkService(services);
  if (cmd !== 'list' && (!service || !services.includes(service))) {
    throw new Error(`Unknown service: ${service}. Use "proxy-toggle list" to see available services`);
  }

  switch (cmd) {
    case 'on':
      enableProxy(service);
      break;
    case 'off':
      disableProxy(service);
      break;
    case 'status':
      status(service, !serviceArg);
      break;
    case 'toggle': {
      const http = getProxyInfo(service, 'http');
      const https = getProxyInfo(service, 'https');
      if (http.enabled || https.enabled) {
        disableProxy(service);
      } else {
        enableProxy(service);
      }
      break;
    }
    case 'reset-bypass':
      resetProxyBypass(service);
      break;
    case 'list':
      listAll(services);
      break;
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
