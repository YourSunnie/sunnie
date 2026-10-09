/*
 * Loaded into Chrome (LD_PRELOAD) by daemon.ts on arm64 CPUs that have SME but not SVE — Apple
 * silicon from the M4 on, which is what a Linux container on such a Mac sees. Chrome 154 for
 * Linux arm64 then runs code containing an SVE instruction (`cntd`) and the tab dies with SIGILL
 * on image-heavy pages. Hiding SME from Chrome makes it take its ordinary NEON paths.
 * Built in the Dockerfile; remove once Chrome no longer crashes without it.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/auxv.h>

/* Bits 23-30 and 37-42 of AT_HWCAP2 announce SME and its extensions on arm64. */
#define SME_BITS ((0xffUL << 23) | (0x3fUL << 37))

unsigned long getauxval(unsigned long type) {
  static unsigned long (*real)(unsigned long);
  if (!real) real = (unsigned long (*)(unsigned long))dlsym(RTLD_NEXT, "getauxval");
  unsigned long value = real(type);
  return type == AT_HWCAP2 ? value & ~SME_BITS : value;
}
