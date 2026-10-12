// Reads what the machine actually has so the launcher can pick local models that fit it.
// Everything that interprets command output is a plain function so it can be tested with
// captured samples; only detectHardware() touches the machine.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const GB = 1024 ** 3;
const MIB = 1024 ** 2;
const round1 = (n) => Math.round(n * 10) / 10;

/** PCI vendor ids are the most reliable signal; the adapter name is the fallback. */
const PCI_VENDORS = {
  '10de': 'nvidia',
  '1002': 'amd',
  '1022': 'amd',
  '8086': 'intel',
  '5143': 'qualcomm',
  '1414': 'virtual',
  '15ad': 'virtual',
};

export function classifyVendor(name = '', pnpId = '') {
  const ven = /VEN_([0-9A-F]{4})/i.exec(String(pnpId))?.[1]?.toLowerCase();
  if (ven && PCI_VENDORS[ven]) return PCI_VENDORS[ven];
  const t = String(name).toLowerCase();
  if (/nvidia|geforce|quadro|\brtx\b|\bgtx\b|tesla/.test(t)) return 'nvidia';
  if (/\bamd\b|radeon|advanced micro devices/.test(t)) return 'amd';
  if (/intel|iris|uhd graphics|\barc\b/.test(t)) return 'intel';
  if (/qualcomm|adreno/.test(t)) return 'qualcomm';
  if (/hyper-v|basic render|remote display|vmware|virtualbox|parallels/.test(t))
    return 'virtual';
  return 'other';
}

/**
 * `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits`
 * prints one line per card: "NVIDIA GeForce RTX 4060 Laptop GPU, 8188, 560.94"
 */
export function parseNvidiaSmi(stdout = '') {
  const gpus = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 2) continue;
    const mib = Number.parseFloat(parts[1]);
    if (!parts[0] || !Number.isFinite(mib) || mib <= 0) continue;
    gpus.push({
      vendor: 'nvidia',
      name: parts[0],
      vramGB: round1(mib / 1024),
      vramSource: 'nvidia-smi',
      driver: parts[2] || null,
    });
  }
  return gpus;
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Interprets the JSON written by WINDOWS_PROBE_SCRIPT. Win32_VideoController.AdapterRAM is a
 * 32-bit field (it saturates near 4 GB), so the display driver's 64-bit registry value is
 * preferred when present.
 */
export function parseWindowsProbe(probe = {}) {
  const cpus = asArray(probe.cpu);
  const registry = asArray(probe.registry);
  const gpus = asArray(probe.gpu).map((g) => {
    const name = String(g.name || '').trim();
    const fromRegistry = registry.find(
      (r) =>
        String(r.name || '')
          .trim()
          .toLowerCase() === name.toLowerCase() && toNumber(r.bytes) > 0
    );
    const wmiBytes = toNumber(g.adapterRam);
    let vramGB = null;
    let vramSource = null;
    if (fromRegistry) {
      vramGB = round1(toNumber(fromRegistry.bytes) / GB);
      vramSource = 'registry';
    } else if (wmiBytes > 0) {
      vramGB = round1(wmiBytes / GB);
      vramSource = 'wmi';
    }
    return {
      vendor: classifyVendor(name, g.pnp),
      name,
      vramGB,
      vramSource,
      driver: g.driver || null,
    };
  });
  return {
    osName: [probe.os?.caption, probe.os?.version].filter(Boolean).join(' ').trim(),
    cpu: {
      name: String(cpus[0]?.name || '').replace(/\s+/g, ' ').trim(),
      cores: cpus.reduce((n, c) => n + toNumber(c.cores), 0),
      threads: cpus.reduce((n, c) => n + toNumber(c.threads), 0),
    },
    gpus,
  };
}

/** Run by Windows PowerShell 5.1 (present on every supported Windows). Prints one JSON line. */
export const WINDOWS_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$os  = Get-CimInstance Win32_OperatingSystem
$cpu = @(Get-CimInstance Win32_Processor | ForEach-Object { [pscustomobject]@{ name = $_.Name; cores = $_.NumberOfCores; threads = $_.NumberOfLogicalProcessors } })
$gpu = @(Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{ name = $_.Name; adapterRam = $_.AdapterRAM; pnp = $_.PNPDeviceID; driver = $_.DriverVersion } })
$reg = @()
foreach ($k in Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0*') {
  $m = $k.'HardwareInformation.qwMemorySize'
  if ($m -is [byte[]]) { $m = [BitConverter]::ToUInt64($m, 0) }
  if ($m) { $reg += [pscustomobject]@{ name = $k.DriverDesc; bytes = [uint64]$m } }
}
[pscustomobject]@{ os = [pscustomobject]@{ caption = $os.Caption; version = $os.Version }; cpu = $cpu; gpu = $gpu; registry = $reg } | ConvertTo-Json -Depth 5 -Compress
`;

function defaultExec(file, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * MIB },
      (error, stdout) => resolve(error ? null : String(stdout))
    );
  });
}

function nvidiaSmiCandidates(platform, env) {
  if (platform !== 'win32') return ['nvidia-smi'];
  const root = env.ProgramFiles || 'C:\\Program Files';
  const sys = env.SystemRoot || 'C:\\Windows';
  return [
    'nvidia-smi',
    path.win32.join(sys, 'System32', 'nvidia-smi.exe'),
    path.win32.join(root, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
  ];
}

/** Free bytes on the drive that holds `target`, found by walking up to a folder that exists. */
export function freeDiskBytes(target, statfs = fs.statfsSync, exists = fs.existsSync) {
  let dir = path.resolve(target);
  for (let i = 0; i < 64 && !exists(dir); i += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const s = statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Free space of the drive that will hold the models. */
export function freeDiskGB(target, statfs = fs.statfsSync, exists = fs.existsSync) {
  const bytes = freeDiskBytes(target, statfs, exists);
  return bytes == null ? null : round1(bytes / GB);
}

/**
 * The machine as the model picker sees it. Never throws: anything that cannot be read is
 * reported as null/empty and noted in `warnings`, and the picker then chooses conservatively.
 */
export async function detectHardware({
  dataDir = os.homedir(),
  platform = process.platform,
  env = process.env,
  exec = defaultExec,
  osModule = os,
  statfs = fs.statfsSync,
} = {}) {
  const warnings = [];
  const hostArch =
    env.PROCESSOR_ARCHITEW6432 === 'ARM64' || env.PROCESSOR_ARCHITECTURE === 'ARM64'
      ? 'arm64'
      : osModule.arch() === 'arm64'
        ? 'arm64'
        : 'x64';

  const cpuList = osModule.cpus() || [];
  let cpu = {
    name: String(cpuList[0]?.model || '').replace(/\s+/g, ' ').trim(),
    cores: null,
    threads: cpuList.length || null,
  };
  let osName = `${osModule.type()} ${osModule.release()}`;
  let gpus = [];

  if (platform === 'win32') {
    const out = await exec(
      path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_PROBE_SCRIPT]
    );
    try {
      const parsed = parseWindowsProbe(JSON.parse(String(out).trim().split(/\r?\n/).pop()));
      if (parsed.osName) osName = parsed.osName;
      if (parsed.cpu.name) cpu = { ...cpu, ...parsed.cpu, threads: parsed.cpu.threads || cpu.threads };
      gpus = parsed.gpus;
    } catch {
      warnings.push('Could not read hardware details from Windows; assuming no GPU.');
    }
  }

  // NVIDIA's own tool is the only dependable source for the VRAM of a card above 4 GB.
  for (const exe of nvidiaSmiCandidates(platform, env)) {
    const out = await exec(exe, [
      '--query-gpu=name,memory.total,driver_version',
      '--format=csv,noheader,nounits',
    ]);
    const smi = out ? parseNvidiaSmi(out) : [];
    if (smi.length) {
      gpus = [...smi, ...gpus.filter((g) => g.vendor !== 'nvidia')];
      break;
    }
  }

  const free = freeDiskGB(dataDir, statfs);
  if (free == null) warnings.push('Could not read free disk space.');

  return {
    platform,
    arch: hostArch,
    osName,
    cpu,
    ramGB: round1(osModule.totalmem() / GB),
    disk: { path: dataDir, freeGB: free },
    gpus,
    warnings,
  };
}
