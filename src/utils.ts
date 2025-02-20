import fs from 'node:fs/promises'
import path from 'node:path'

import hashObjectImpl from 'hash-object'
import timeFormat from 'hh-mm-ss'

export {
  assert,
  getEnv,
  normalizeAuthors,
  parseJsonpResponse
} from 'kindle-api-ky'

const numerals = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }

export function deromanize(romanNumeral: string): number {
  const roman = romanNumeral.toUpperCase().split('')
  let num = 0
  let val = 0

  while (roman.length) {
    val = numerals[roman.shift()! as keyof typeof numerals]
    num += val * (val < numerals[roman[0] as keyof typeof numerals] ? -1 : 1)
  }

  return num
}

export async function fileExists(
  filePath: string,
  mode: number = fs.constants.F_OK | fs.constants.R_OK
): Promise<boolean> {
  try {
    await fs.access(filePath, mode)
    return true
  } catch {
    return false
  }
}

export function hashObject(obj: Record<string, any>): string {
  return hashObjectImpl(obj, {
    algorithm: 'sha1',
    encoding: 'hex'
  })
}

export type FfmpegProgressEvent = {
  frames: number
  currentFps: number
  currentKbps: number
  targetSize: number
  timemark: string
  percent?: number | undefined
}

export function ffmpegOnProgress(
  onProgress: (progress: number, event: FfmpegProgressEvent) => void,
  durationMs: number
) {
  return (event: FfmpegProgressEvent) => {
    let progress = 0

    try {
      const timestamp = timeFormat.toMs(event.timemark)
      progress = timestamp / durationMs
    } catch { }

    if (
      Number.isNaN(progress) &&
      event.percent !== undefined &&
      !Number.isNaN(event.percent)
    ) {
      progress = event.percent / 100
    }

    if (!Number.isNaN(progress)) {
      progress = Math.max(0, Math.min(1, progress))
      onProgress(progress, event)
    }
  }
}

export function isPromise<T, S>(obj: PromiseLike<T> | S): obj is PromiseLike<T> {
  return !!obj && (typeof obj === 'object' || typeof obj === 'function') && 'then' in obj && typeof obj.then === 'function';
}

export async function withDefer<T>(body: (defer: (deferral: (err: any) => void | Promise<void>) => void) => T) {
  const defferals: Array<(err: any) => void | Promise<void>> = []
  const defer = (defferal: (err: any) => void | Promise<void>) => { defferals.push(defferal) }

  const runDeferrals = async (err: any) => {
    for (let i = 1; i <= defferals.length; i++) {
      const deferral = defferals[defferals.length - i]!
      try {
        const res = deferral(err)
        if (isPromise(res)) await res
      } catch { }
    }
  }

  try {
    const r = body(defer)
    const ret = isPromise(r) ? await r : r
    await runDeferrals(null)
    return ret
  } catch (err) {
    await runDeferrals(err)
    throw err
  }
}

export function errCode(err: unknown) {
  if (typeof err !== 'object' || !err) return undefined
  return 'code' in err ? err.code : undefined
}

export function maybeURL(arg: string) {
  try {
    return new URL(arg)
  } catch (err) {
    if (errCode(err) === 'ERR_INVALID_URL') return undefined
    else throw err
  }
}

export async function mayStat(filename: string) {
  try {
    return await fs.stat(filename)
  } catch (err) {
    if (errCode(err) === 'ENOENT') return undefined
    else throw err
  }
}

export async function niceOpen(filename: string, flags: string = 'r') {
  try {
    return await fs.open(filename, flags)
  } catch (err) {
    if (errCode(err) != 'ENOENT')
      throw err
  }
  if (flags.startsWith('w') || flags.startsWith('a')) {
    await fs.mkdir(path.dirname(filename), { recursive: true })
    return fs.open(filename, flags)
  }
  // assert(flags.startsWith('r'))
  return null
}
