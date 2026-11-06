'use strict';

const cp = require('node:child_process');

const VM_SIGNATURES = [
  'virtualbox', 'vmware', 'hyper-v', 'kvm', 'qemu', 'xen',
  'parallels', 'virtual machine', 'bochs'
];

function defaultRunner(script) {
  try {
    return cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 4000, windowsHide: true }).trim();
  } catch { return ''; }
}

function detect(opts = {}) {
  const run = opts.runPowerShell || defaultRunner;
  const cs = run('(Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model | ConvertTo-Json -Compress)');
  const bios = run('(Get-CimInstance Win32_BIOS | Select-Object SerialNumber,Manufacturer | ConvertTo-Json -Compress)');

  const haystack = (cs + ' ' + bios).toLowerCase();
  let matchedType = null;
  for (const sig of VM_SIGNATURES) {
    if (haystack.includes(sig)) { matchedType = sig; break; }
  }

  return { isVM: !!matchedType, type: matchedType };
}

module.exports = { detect, VM_SIGNATURES };
