import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { createGlobalProxyAgent } from 'global-agent';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const localBypass = ['localhost', '127.0.0.1', '::1', '[::1]'];
const fail = code => Object.assign(new Error(code), { code });

export function proxyUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.includes('://') ? value.trim() : 'http://' + value.trim());
    if (url.protocol !== 'http:' || !url.hostname || url.pathname !== '/' || url.search || url.hash) throw fail('network-proxy-invalid');
    return url.href;
  } catch { throw fail('network-proxy-invalid'); }
}

export function windowsProxy(text) {
  const enabled = text.match(/\bProxyEnable\s+REG_DWORD\s+(0x[\da-f]+|\d+)/i)?.[1];
  if (!enabled || Number(enabled) !== 1) return '';
  const server = text.match(/\bProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
  if (!server) return '';
  if (!server.includes('=')) return proxyUrl(server);
  const map = Object.fromEntries(server.split(';').map(item => item.trim().split('=', 2)));
  return proxyUrl(map.https || map.http || '');
}

export async function readWindowsProxy() {
  if (process.platform !== 'win32') return '';
  try {
    const { stdout } = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { windowsHide: true, timeout: 3000, maxBuffer: 65536 });
    return windowsProxy(stdout);
  } catch (error) { if (error.code === 'network-proxy-invalid') throw error; return ''; }
}

export function resolveNetwork(settings = {}, env = process.env, systemProxy = '') {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw fail('network-config-invalid');
  if (Object.keys(settings).some(key => !['proxyMode', 'proxyUrl', 'noProxy'].includes(key))) throw fail('network-config-invalid');
  const mode = settings.proxyMode ?? 'system';
  if (!['system', 'environment', 'direct', 'custom'].includes(mode)) throw fail('network-config-invalid');
  if (settings.proxyUrl !== undefined && typeof settings.proxyUrl !== 'string') throw fail('network-config-invalid');
  if (settings.noProxy !== undefined && (!Array.isArray(settings.noProxy) || settings.noProxy.some(item => typeof item !== 'string' || /[\r\n]/.test(item)))) throw fail('network-config-invalid');
  const environmentHttp = env.http_proxy || env.HTTP_PROXY || '';
  const environmentHttps = env.https_proxy || env.HTTPS_PROXY || environmentHttp;
  const custom = mode === 'custom' ? proxyUrl(settings.proxyUrl) : '';
  if (mode === 'custom' && !custom) throw fail('network-proxy-missing');
  const fallback = mode === 'system' ? systemProxy : '';
  const httpProxy = mode === 'direct' ? '' : mode === 'custom' ? custom : proxyUrl(environmentHttp || fallback);
  const httpsProxy = mode === 'direct' ? '' : mode === 'custom' ? custom : proxyUrl(environmentHttps || fallback);
  const noProxy = [...new Set([...localBypass, ...(settings.noProxy ?? []), ...(env.no_proxy || env.NO_PROXY || '').split(',').map(item => item.trim()).filter(Boolean)])].join(',');
  return { mode, viaProxy: !!(httpProxy || httpsProxy), source: mode === 'direct' ? 'direct' : custom ? 'custom' : environmentHttp || environmentHttps ? 'environment' : fallback ? 'system' : 'direct', proxyEnv: { http_proxy: httpProxy, https_proxy: httpsProxy, no_proxy: noProxy } };
}

/** Node handles fetch; the Discord.js recommended global-agent handles SDK WebSockets. */
export async function configureRuntimeNetwork(root, { env = process.env, system = readWindowsProxy, apply = http.setGlobalProxyFromEnv } = {}) {
  let settings = {};
  try {
    const document = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw fail('network-config-invalid');
    settings = document.network ?? {};
  } catch (error) { if (error.code !== 'ENOENT') throw fail('network-config-invalid'); }
  const network = resolveNetwork(settings, env, (settings.proxyMode ?? 'system') === 'system' ? await system() : '');
  if (typeof apply !== 'function') {
    if (network.viaProxy) throw fail('network-runtime-upgrade-required');
    return { ...network, restore() {} };
  }
  const restoreNode = apply(network.proxyEnv);
  if (!network.viaProxy) return { ...network, restore: restoreNode };
  const before = [http, https].map(module => ({ module, get: module.get, request: module.request, globalAgent: module.globalAgent }));
  let controller;
  try {
    controller = createGlobalProxyAgent({ environmentVariableNamespace: 'DSH_NETWORK_', forceGlobalAgent: false, socketConnectionTimeout: 15000 });
    controller.HTTP_PROXY = network.proxyEnv.http_proxy || null;
    controller.HTTPS_PROXY = network.proxyEnv.https_proxy || null;
    controller.NO_PROXY = network.proxyEnv.no_proxy;
  } catch {
    for (const saved of before) Object.assign(saved.module, { get: saved.get, request: saved.request, globalAgent: saved.globalAgent });
    restoreNode();
    throw fail('network-proxy-init-failed');
  }
  const installed = before.map(({ module }) => ({ get: module.get, request: module.request, globalAgent: module.globalAgent }));
  let restored = false;
  return { ...network, restore() {
    if (restored) return;
    restored = true;
    controller.HTTP_PROXY = controller.HTTPS_PROXY = null;
    for (let i = 0; i < before.length; i++) {
      const saved = before[i];
      for (const key of ['get', 'request', 'globalAgent']) if (saved.module[key] === installed[i][key]) saved.module[key] = saved[key];
    }
    restoreNode();
  } };
}
