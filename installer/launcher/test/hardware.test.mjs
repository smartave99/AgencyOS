import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  classifyVendor,
  parseNvidiaSmi,
  parseWindowsProbe,
  detectHardware,
  freeDiskGB,
} from '../lib/hardware.mjs';

const GB = 1024 ** 3;

describe('classifyVendor', () => {
  it('trusts the PCI vendor id over the marketing name', () => {
    assert.equal(classifyVendor('Some Card', 'PCI\\VEN_10DE&DEV_2882'), 'nvidia');
    assert.equal(classifyVendor('Some Card', 'PCI\\VEN_1002&DEV_744C'), 'amd');
    assert.equal(classifyVendor('Some Card', 'PCI\\VEN_8086&DEV_46A6'), 'intel');
    assert.equal(classifyVendor('Microsoft Hyper-V Video', 'VMBUS\\{5620e0c7}'), 'virtual');
  });
  it('falls back to the adapter name', () => {
    assert.equal(classifyVendor('NVIDIA GeForce RTX 4060 Laptop GPU'), 'nvidia');
    assert.equal(classifyVendor('AMD Radeon(TM) Graphics'), 'amd');
    assert.equal(classifyVendor('Intel(R) Iris(R) Xe Graphics'), 'intel');
    assert.equal(classifyVendor('Qualcomm(R) Adreno(TM) X1-85 GPU'), 'qualcomm');
    assert.equal(classifyVendor('Mystery'), 'other');
  });
});

describe('parseNvidiaSmi', () => {
  it('reads one GPU per line and converts MiB to GB', () => {
    const gpus = parseNvidiaSmi(
      'NVIDIA GeForce RTX 4060 Laptop GPU, 8188, 560.94\r\nNVIDIA RTX A2000, 6138, 560.94\r\n'
    );
    assert.equal(gpus.length, 2);
    assert.deepEqual(gpus[0], {
      vendor: 'nvidia',
      name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
      vramGB: 8,
      vramSource: 'nvidia-smi',
      driver: '560.94',
    });
    assert.equal(gpus[1].vramGB, 6);
  });
  it('ignores error text and blank output', () => {
    assert.deepEqual(parseNvidiaSmi(''), []);
    assert.deepEqual(parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate'), []);
    assert.deepEqual(parseNvidiaSmi('x, notanumber, 1'), []);
  });
});

describe('parseWindowsProbe', () => {
  const probe = {
    os: { caption: 'Microsoft Windows 11 Home', version: '10.0.26100' },
    cpu: { name: 'Intel(R) Core(TM) i7-1355U', cores: 10, threads: 12 },
    gpu: [
      { name: 'Intel(R) Iris(R) Xe Graphics', adapterRam: 1073741824, pnp: 'PCI\\VEN_8086&DEV_A7A1', driver: '31.0' },
      { name: 'AMD Radeon RX 7600M XT', adapterRam: 4293918720, pnp: 'PCI\\VEN_1002&DEV_7480', driver: '32.0' },
    ],
    registry: [{ name: 'AMD Radeon RX 7600M XT', bytes: 8573157376 }],
  };
  it('prefers the 64-bit registry value over the saturated WMI value', () => {
    const hw = parseWindowsProbe(probe);
    const amd = hw.gpus.find((g) => g.vendor === 'amd');
    assert.equal(amd.vramSource, 'registry');
    assert.equal(amd.vramGB, 8);
    const intel = hw.gpus.find((g) => g.vendor === 'intel');
    assert.equal(intel.vramSource, 'wmi');
  });
  it('sums multiple processors and tolerates single objects (PowerShell unwraps one-item arrays)', () => {
    const hw = parseWindowsProbe({ ...probe, cpu: { name: 'X', cores: 4, threads: 8 }, gpu: probe.gpu[0], registry: null });
    assert.equal(hw.cpu.threads, 8);
    assert.equal(hw.gpus.length, 1);
    assert.equal(hw.osName, 'Microsoft Windows 11 Home 10.0.26100');
  });
  it('survives an empty probe', () => {
    const hw = parseWindowsProbe({});
    assert.deepEqual(hw.gpus, []);
    assert.equal(hw.cpu.threads, 0);
  });
});

describe('freeDiskGB', () => {
  it('walks up to an existing folder and converts blocks to GB', () => {
    const seen = [];
    const free = freeDiskGB(
      '/data/agencyos/models',
      (dir) => {
        seen.push(dir);
        return { bavail: 50, bsize: GB };
      },
      (dir) => dir === path.resolve('/data') || dir === path.parse(path.resolve('/')).root
    );
    assert.equal(free, 50);
    assert.equal(seen[0], path.resolve('/data'));
  });
  it('returns null when the filesystem cannot be read', () => {
    assert.equal(
      freeDiskGB('/x', () => { throw new Error('nope'); }, () => true),
      null
    );
  });
});

describe('detectHardware', () => {
  const fakeOs = (over = {}) => ({
    arch: () => 'x64',
    type: () => 'Windows_NT',
    release: () => '10.0.26100',
    totalmem: () => 16 * GB,
    cpus: () => Array.from({ length: 8 }, () => ({ model: 'Fake  CPU' })),
    ...over,
  });
  const statfs = () => ({ bavail: 100, bsize: GB });

  it('combines Windows details with NVIDIA VRAM from nvidia-smi', async () => {
    const calls = [];
    const hw = await detectHardware({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      osModule: fakeOs(),
      statfs,
      dataDir: process.cwd(),
      exec: async (file, args) => {
        calls.push(file);
        if (/powershell/i.test(file))
          return JSON.stringify({
            os: { caption: 'Windows 11 Pro', version: '10.0.26100' },
            cpu: { name: 'Fake CPU', cores: 6, threads: 12 },
            gpu: [{ name: 'NVIDIA GeForce RTX 4070', adapterRam: 4293918720, pnp: 'PCI\\VEN_10DE&DEV_2786' }],
            registry: [],
          });
        if (/nvidia-smi/i.test(file)) return 'NVIDIA GeForce RTX 4070, 12282, 555.1\n';
        return null;
      },
    });
    assert.equal(hw.ramGB, 16);
    assert.equal(hw.cpu.threads, 12);
    assert.equal(hw.gpus.length, 1);
    assert.equal(hw.gpus[0].vramGB, 12);
    assert.equal(hw.gpus[0].vramSource, 'nvidia-smi');
    assert.equal(hw.disk.freeGB, 100);
    assert.deepEqual(hw.warnings, []);
    assert.ok(calls.some((c) => /powershell/i.test(c)));
  });

  it('degrades with a warning, never throws, when Windows gives no usable answer', async () => {
    const hw = await detectHardware({
      platform: 'win32',
      env: {},
      osModule: fakeOs({ totalmem: () => 8 * GB }),
      statfs: () => { throw new Error('denied'); },
      exec: async () => 'not json',
    });
    assert.equal(hw.ramGB, 8);
    assert.deepEqual(hw.gpus, []);
    assert.equal(hw.disk.freeGB, null);
    assert.equal(hw.warnings.length, 2);
  });

  it('reports a Windows-on-ARM host even when the launcher itself runs emulated', async () => {
    const hw = await detectHardware({
      platform: 'linux',
      env: { PROCESSOR_ARCHITEW6432: 'ARM64' },
      osModule: fakeOs(),
      statfs,
      exec: async () => null,
    });
    assert.equal(hw.arch, 'arm64');
  });
});
