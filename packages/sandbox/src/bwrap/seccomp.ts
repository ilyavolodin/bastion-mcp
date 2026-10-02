import { z } from 'zod';

/**
 * Generates the classic-BPF seccomp filter loaded with `bwrap --seccomp 3` from the Docker-format profile
 * `deploy/docker/sandbox-seccomp.json` (8.5). The program is built at startup, once per architecture.
 *
 * Supported profile subset: `defaultAction` ALLOW or ERRNO, and `syscalls` entries with `names`, `action`
 * (`SCMP_ACT_ERRNO` with `errnoRet`, `SCMP_ACT_KILL_PROCESS`, `SCMP_ACT_KILL`, `SCMP_ACT_ALLOW`) and optional
 * `args` using `SCMP_CMP_EQ` or `SCMP_CMP_MASKED_EQ` (Docker semantics: `(arg & value) == valueTwo`). Only the
 * low 32 bits of an argument are compared, which covers the clone/unshare flag words.
 */

export type SeccompArch = 'x86_64' | 'aarch64';

const AUDIT_ARCH: Record<SeccompArch, number> = { x86_64: 0xc000003e, aarch64: 0xc00000b7 };
const X32_SYSCALL_BIT = 0x40000000;

const RET = {
  KILL_PROCESS: 0x80000000,
  KILL: 0x00000000,
  ALLOW: 0x7fff0000,
  ERRNO: 0x00050000,
} as const;

/** Syscall numbers (Linux 6.x). `undefined` means the syscall does not exist on that architecture. */
const SYSCALLS: Record<string, { x86_64?: number; aarch64?: number }> = {
  ptrace: { x86_64: 101, aarch64: 117 },
  process_vm_readv: { x86_64: 310, aarch64: 270 },
  process_vm_writev: { x86_64: 311, aarch64: 271 },
  mount: { x86_64: 165, aarch64: 40 },
  umount2: { x86_64: 166, aarch64: 39 },
  pivot_root: { x86_64: 155, aarch64: 41 },
  chroot: { x86_64: 161, aarch64: 51 },
  keyctl: { x86_64: 250, aarch64: 219 },
  add_key: { x86_64: 248, aarch64: 217 },
  request_key: { x86_64: 249, aarch64: 218 },
  bpf: { x86_64: 321, aarch64: 280 },
  userfaultfd: { x86_64: 323, aarch64: 282 },
  perf_event_open: { x86_64: 298, aarch64: 241 },
  kexec_load: { x86_64: 246, aarch64: 104 },
  kexec_file_load: { x86_64: 320, aarch64: 294 },
  setns: { x86_64: 308, aarch64: 268 },
  unshare: { x86_64: 272, aarch64: 97 },
  clone: { x86_64: 56, aarch64: 220 },
  clone3: { x86_64: 435, aarch64: 435 },
  init_module: { x86_64: 175, aarch64: 105 },
  finit_module: { x86_64: 313, aarch64: 273 },
  delete_module: { x86_64: 176, aarch64: 106 },
  reboot: { x86_64: 169, aarch64: 142 },
  swapon: { x86_64: 167, aarch64: 224 },
  swapoff: { x86_64: 168, aarch64: 225 },
  acct: { x86_64: 163, aarch64: 89 },
  iopl: { x86_64: 172 },
  ioperm: { x86_64: 173 },
  quotactl: { x86_64: 179, aarch64: 60 },
  lookup_dcookie: { x86_64: 212, aarch64: 18 },
  name_to_handle_at: { x86_64: 303, aarch64: 264 },
  open_by_handle_at: { x86_64: 304, aarch64: 265 },
  mount_setattr: { x86_64: 442, aarch64: 442 },
  move_mount: { x86_64: 429, aarch64: 429 },
  open_tree: { x86_64: 428, aarch64: 428 },
  fsopen: { x86_64: 430, aarch64: 430 },
  fsconfig: { x86_64: 431, aarch64: 431 },
  fsmount: { x86_64: 432, aarch64: 432 },
  fspick: { x86_64: 433, aarch64: 433 },
};

export const knownSyscalls = (): string[] => Object.keys(SYSCALLS);

const ACTIONS = ['SCMP_ACT_ALLOW', 'SCMP_ACT_ERRNO', 'SCMP_ACT_KILL', 'SCMP_ACT_KILL_PROCESS'] as const;

export const seccompProfileSchema = z.object({
  defaultAction: z.enum(['SCMP_ACT_ALLOW', 'SCMP_ACT_ERRNO']),
  defaultErrnoRet: z.number().int().min(1).max(4095).optional(),
  syscalls: z.array(
    z.object({
      names: z.array(z.string()).min(1),
      action: z.enum(ACTIONS),
      errnoRet: z.number().int().min(1).max(4095).optional(),
      comment: z.string().optional(),
      args: z
        .array(
          z.object({
            index: z.number().int().min(0).max(5),
            value: z.number().int().nonnegative(),
            valueTwo: z.number().int().nonnegative().optional(),
            op: z.enum(['SCMP_CMP_EQ', 'SCMP_CMP_MASKED_EQ']),
          }),
        )
        .optional(),
    }),
  ),
});
export type SeccompProfile = z.infer<typeof seccompProfileSchema>;

export type BpfInstruction = { code: number; jt: number; jf: number; k: number };

const BPF = {
  LD_W_ABS: 0x20,
  AND_K: 0x54,
  JEQ_K: 0x15,
  JSET_K: 0x45,
  RET_K: 0x06,
} as const;

const OFFSET = { nr: 0, arch: 4, args: (i: number) => 16 + 8 * i } as const;

const ins = (code: number, k: number, jt = 0, jf = 0): BpfInstruction => ({ code, jt, jf, k });

const retValue = (action: (typeof ACTIONS)[number], errno: number | undefined): number => {
  switch (action) {
    case 'SCMP_ACT_ALLOW':
      return RET.ALLOW;
    case 'SCMP_ACT_KILL':
      return RET.KILL;
    case 'SCMP_ACT_KILL_PROCESS':
      return RET.KILL_PROCESS;
    case 'SCMP_ACT_ERRNO':
      return RET.ERRNO | (errno ?? 1);
  }
};

/** Compiles the profile into BPF instructions for one architecture. */
export const compileSeccomp = (profileInput: unknown, arch: SeccompArch): BpfInstruction[] => {
  const profile = seccompProfileSchema.parse(profileInput);
  const program: BpfInstruction[] = [
    ins(BPF.LD_W_ABS, OFFSET.arch),
    ins(BPF.JEQ_K, AUDIT_ARCH[arch], 1, 0),
    ins(BPF.RET_K, RET.KILL_PROCESS),
  ];
  if (arch === 'x86_64') {
    // x32 ABI syscalls (nr | 0x40000000) would bypass a number-based denylist.
    program.push(ins(BPF.LD_W_ABS, OFFSET.nr), ins(BPF.JSET_K, X32_SYSCALL_BIT, 0, 1), ins(BPF.RET_K, RET.KILL_PROCESS));
  }
  for (const entry of profile.syscalls) {
    const action = retValue(entry.action, entry.errnoRet);
    for (const name of entry.names) {
      const def = SYSCALLS[name];
      if (!def) throw new Error(`seccomp profile names unknown syscall "${name}"`);
      const nr = def[arch];
      if (nr === undefined) continue; // not present on this architecture
      const conditions = (entry.args ?? []).flatMap((arg) => {
        const mask = arg.op === 'SCMP_CMP_EQ' ? 0xffffffff : arg.value;
        const expected = arg.op === 'SCMP_CMP_EQ' ? arg.value : (arg.valueTwo ?? 0);
        return [
          ins(BPF.LD_W_ABS, OFFSET.args(arg.index)),
          ins(BPF.AND_K, mask >>> 0),
          // jf is patched below to skip to the end of the block
          ins(BPF.JEQ_K, expected >>> 0, 0, 0),
        ];
      });
      const block: BpfInstruction[] = [
        ins(BPF.LD_W_ABS, OFFSET.nr),
        ins(BPF.JEQ_K, nr, 0, 0),
        ...conditions,
        ins(BPF.RET_K, action),
      ];
      // Patch the not-equal branches to jump past the block's final RET.
      block.forEach((instruction, index) => {
        if (instruction.code === BPF.JEQ_K) instruction.jf = block.length - 1 - index;
      });
      for (const instruction of block) {
        if (instruction.jf > 255) throw new Error('seccomp block too large for a short jump');
      }
      program.push(...block);
    }
  }
  const defaultRet =
    profile.defaultAction === 'SCMP_ACT_ALLOW' ? RET.ALLOW : RET.ERRNO | (profile.defaultErrnoRet ?? 1);
  program.push(ins(BPF.RET_K, defaultRet));
  if (program.length > 4096) throw new Error('seccomp program exceeds BPF_MAXINSNS');
  return program;
};

/** Serializes to the `struct sock_filter[]` byte layout expected on the `--seccomp` fd (little endian). */
export const serializeBpf = (program: readonly BpfInstruction[]): Buffer => {
  const out = Buffer.alloc(program.length * 8);
  program.forEach((instruction, index) => {
    const at = index * 8;
    out.writeUInt16LE(instruction.code, at);
    out.writeUInt8(instruction.jt, at + 2);
    out.writeUInt8(instruction.jf, at + 3);
    out.writeUInt32LE(instruction.k >>> 0, at + 4);
  });
  return out;
};

export const hostSeccompArch = (arch: string = process.arch): SeccompArch => {
  if (arch === 'x64') return 'x86_64';
  if (arch === 'arm64') return 'aarch64';
  throw new Error(`seccomp filter is not generated for architecture ${arch}`);
};

export const generateSeccompBpf = (profile: unknown, arch: SeccompArch = hostSeccompArch()): Buffer =>
  serializeBpf(compileSeccomp(profile, arch));

/** Minimal interpreter for the subset of BPF used above; the unit tests use it to verify decisions. */
export const evaluateSeccomp = (
  program: readonly BpfInstruction[],
  data: { nr: number; arch: number; args?: readonly number[] },
): number => {
  let a = 0;
  let pc = 0;
  const load = (offset: number): number => {
    if (offset === OFFSET.nr) return data.nr >>> 0;
    if (offset === OFFSET.arch) return data.arch >>> 0;
    const index = (offset - 16) / 8;
    return (data.args?.[index] ?? 0) >>> 0;
  };
  for (let steps = 0; steps < 100_000; steps += 1) {
    const instruction = program[pc];
    if (!instruction) throw new Error('BPF program ran off the end');
    switch (instruction.code) {
      case BPF.LD_W_ABS:
        a = load(instruction.k);
        pc += 1;
        break;
      case BPF.AND_K:
        a = (a & instruction.k) >>> 0;
        pc += 1;
        break;
      case BPF.JEQ_K:
        pc += 1 + (a === instruction.k >>> 0 ? instruction.jt : instruction.jf);
        break;
      case BPF.JSET_K:
        pc += 1 + ((a & instruction.k) !== 0 ? instruction.jt : instruction.jf);
        break;
      case BPF.RET_K:
        return instruction.k >>> 0;
      default:
        throw new Error(`unsupported BPF opcode ${instruction.code}`);
    }
  }
  throw new Error('BPF program did not terminate');
};

export const SECCOMP_RET = RET;
export const SECCOMP_AUDIT_ARCH = AUDIT_ARCH;
export const syscallNumber = (name: string, arch: SeccompArch): number | undefined =>
  SYSCALLS[name]?.[arch];
