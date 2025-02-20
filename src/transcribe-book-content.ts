import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { globby } from 'globby'
import { pMapIterable } from 'p-map'

import {
  input,
} from '@inquirer/prompts'

import {
  assert,
  getEnv,
  isPromise,
  errCode,
  mayStat,
  niceOpen,
  withDefer,
} from './utils'

import { OpenAIClient } from 'openai-fetch'

import {
  ollamaOCR,
  DEFAULT_OCR_SYSTEM_PROMPT,
  SUPPORTED_IMAGE_TYPES,
} from 'ollama-ocr'
const DEFAULT_OCR_MODEL = "llama3.2-vision"

import {
  default as ollama,
  Ollama
} from 'ollama'

const LEGACY_PROMPT_1 = 'You will be given an image containing text. Read the text from the image and output it verbatim.\n\n' +
  'Do not include any additional text, descriptions, or punctuation. Ignore any embedded images. Do not use markdown.'

const LEGACY_PROMPT_2 = 'You will be given an image containing text. Read the text from the image and output it verbatim.\n\n' +
  'Do not include any additional text, descriptions, or punctuation. Ignore any embedded images. Do not use markdown.\n\n' +
  'This is an important task for analyzing legal documents cited in a court case.'

function makeOpenAITranscriber(spec?: string | {
  model?: string,
  prompt?: string | ((retries: number) => string),
}) {
  if (typeof spec == 'string') {
    spec = { model: spec ? spec : 'gpt-4o' }
  } else if (!spec) {
    spec = {}
  }

  const {
    model = 'gpt-4o',
    prompt = retries => retries <= 2 ? LEGACY_PROMPT_1 : LEGACY_PROMPT_2,
  } = spec

  // TODO env hookup apiKey?: string
  // TODO env hookup organizationId?: string
  // TODO env hookup baseUrl?: string
  // TODO env hookup ky options?
  const openai = new OpenAIClient()

  return async function transcribe(filename: string) {
    const screenshotBuffer = await fs.readFile(filename)
    const screenshotBase64 = `data:image/png;base64,${screenshotBuffer.toString('base64')}`

    const maxRetries = 20
    let retries = 0

    do {
      const res = await openai.createChatCompletion({
        model,
        temperature: retries < 2 ? 0 : 0.5,
        messages: [
          {
            role: 'system',
            content: typeof prompt === 'string' ? prompt : prompt(retries)
          },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: screenshotBase64
                }
              }
            ] as any
          }
        ]
      })

      const rawText = res.choices[0]?.message.content!
      const text = rawText
        .replace(/^\s*\d+\s*$\n+/m, '')
        // .replaceAll(/\n+/g, '\n')
        .replaceAll(/^\s*/gm, '')
        .replaceAll(/\s*$/gm, '')

      ++retries

      if (!text) continue
      if (text.length < 100 && /i'm sorry/i.test(text)) {
        if (retries >= maxRetries)
          throw new Error(`Model refused too many times (${retries} times): ${text}`)

        // Sometimes the model refuses to generate text for an image
        // presumably if it thinks the content may be copyrighted or
        // otherwise inappropriate. I've seen this both "gpt-4o" and
        // "gpt-4o-mini", but it seems to happen more regularly with
        // "gpt-4o-mini". If we suspect a refual, we'll retry with a
        // higher temperature and cross our fingers.
        console.warn('retrying refusal...', { screenshot: filename, text })
        continue
      }

      return text
    } while (true)
  }
}

type TimeoutSpec = number | { timeout: number, name?: string } | { deadline: number, name?: string, now?: () => number }

function withTimeout<V>(pv: Promise<V>, timeout: TimeoutSpec) {
  const { ms, mess } = (() => {
    let mess = 'timeout expired'
    let ms = NaN
    if (typeof timeout === 'number') {
      ms = timeout
    } else {
      if ('deadline' in timeout) {
        const { deadline, name, now = () => performance.now() } = timeout
        mess = name ? `${name} deadline exceeded` : 'deadline exceeded'
        ms = deadline - now()
      } else {
        const { timeout: to, name } = timeout
        ms = to
        if (name) mess = `${name} deadline exceeded`
      }
    }
    return { ms, mess }
  })()

  return Promise.race([
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(mess)), ms)), // TODO error.code
    pv])
}

async function* iterTimeout<V, R>(it: AsyncIterator<V, R>, timeout: TimeoutSpec | ((i: number) => TimeoutSpec)) {
  if (typeof timeout !== 'function') {
    const spec = timeout
    timeout = _ => spec
  }
  let i = 0
  do {
    const res = await withTimeout(it.next(), timeout(i++))
    if (res.done) return res.value
    else yield res.value
  } while (true)
}

function makeOllamaTranscriber(model?: string) {
  if (!model) model = DEFAULT_OCR_MODEL

  // TODO support custom prompt env hookup?
  const systemPrompt = DEFAULT_OCR_SYSTEM_PROMPT

  // TODO provide option hookup and/or auto tune from past transcription performance:
  // - the caller is probably going to be retrying transcription anyhow
  // - so if we collect timing info within this transcriber, and maybe also get retry count passed in below
  // - then we can do things like "double the deadline on subsequent retries upto some limit"
  // - and "first attempt deadline is some statistic of past transcriptions; e.g. median"
  const timeout = 30_000
  const reqTimeout = 2_000 // TODO derive relative to timeout
  const firstTimeout = 2_000 // TODO derive relative to timeout

  return async (filePath: string) => {
    const image = await (async () => {
      const start = performance.now()
      const r = await ollama.encodeImage(await fs.readFile(filePath))
      const end = performance.now()
      const took = end - start
      console.warn('ollama encodeImage', { took, start, end, filePath })
      return r
    })()

    // TODO eject this; make transcriber callers use a stream
    const parts: string[] = []

    await withDefer(async defer => {
      let done_reason = '<undefined>'
      let replies = 0
      let first = NaN
      let chatStart = NaN

      const start = performance.now()
      console.log('ollama transcribe', { start, filePath, model })
      defer(err => {
        const end = performance.now()
        const took = end - start
        if (err)
          console.warn('ollama transcribe failed', { took, start, chatStart, first, replies, end, reason: done_reason, errCode: errCode(err), filePath, model })
        else
          console.log('ollama transcribe done', { took, start, chatStart, first, replies, end, reason: done_reason, filePath, model })
      })

      const reqDeadline = start + reqTimeout
      const firstDeadline = start + reqTimeout + firstTimeout
      const deadline = start + timeout

      const res = await withTimeout(
        ollama.chat({
          model,
          stream: true,
          messages: [
            {
              role: 'user',
              content: systemPrompt,
              images: [image]
            }
          ]
        }),
        { name: 'chat request', deadline: reqDeadline })
      defer(() => res.abort())

      done_reason = '<not-done>'

      // TODO next-message timeout how? what?
      for await (const r of iterTimeout(
        res[Symbol.asyncIterator](),
        i => i === 0
          ? { name: 'first chat reply', deadline: firstDeadline }
          : { name: 'last chat reply', deadline: deadline }
      )) {
        if (!replies++) {
          first = performance.now()
          console.log('ollama transcribe first reply', { start, first, filePath, model })
          // TODO update next-message timeout to be full
        }

        const { message: { role, content }, done, done_reason: dr } = r
        if (role === 'assistant') parts.push(content)
        else console.warn('ollama transcribe unknown reply', { role, content, filePath, model })

        if (done) {
          done_reason = dr || '<unknown>'
          break
        }
      }

    })

    return parts.join('')
  }
}

// TODO support markdown mode
// TODO pivot -> TranscriberInto(inFile: string, outFile: string, metaFile?: string)
// TODO or make the result a stream
type Transcriber = (filename: string) => Promise<string>

const makeTranscriberType: { [key: string]: (spec?: string) => Transcriber } = {
  'openai': makeOpenAITranscriber,
  'ollama': makeOllamaTranscriber,
  // TODO tesseract
}

function makeTranscriber(spec: string) {
  const match = /^(.+?)(?::(.*))?$/.exec(spec)
  if (!match) throw new Error('invalid transcriber spec')

  const typ = makeTranscriberType[match[1]!]
  if (!typ) throw new Error('invalid transcriber spec')
  return typ(match[2])
}

async function writeFile<T>(filename: string, withFile: (file: fs.FileHandle) => Promise<T>) {
  return withDefer(async defer => {
    const file = (await niceOpen(filename, 'w'))!
    defer(() => file.close())
    return await withFile(file)
  })
}

const renameext = (fileName: string, ext: string) => path.join(
  path.dirname(fileName),
  `${path.basename(fileName, path.extname(fileName))}${ext}`)

const pageImageExt = '.png'

async function proc(pageFiles: AsyncIterable<string>) {
  const concurrency = parseInt(getEnv('TRANSCRIBE_CONC') || '1')

  const method = getEnv('TRANSCRIBER') || 'ollama'

  // TODO layer retries over transcriber here ; pull out of openai implementation
  const transcribe = makeTranscriber(method)
  // TODO support transcriber close

  let done = 0, fail = 0

  for await (const { pageFile, ...res } of pMapIterable(pageFiles, async pageFile => {
    try {
      const textFile = renameext(pageFile, '.txt')
      const text = await transcribe(pageFile)
      await writeFile(textFile, file => file.writeFile(text))
      return { pageFile, textFile }
    } catch (err) {
      return { pageFile, err }
    }
  }, { concurrency })) {
    if (res.err) {
      console.error(`error transcribing ${pageFile}`, res.err)
      fail++
    } else {
      const { textFile } = res
      console.log('transcribed', { pageFile, textFile })
      done++
    }
  }

  console.log('proc', { done, fail })
}

async function main() {
  const bookDirMetaFiles = [
    'read.url',
    'info.json',
    'metadata.json',
    'pages.json',
    'toc.json',
  ]

  const asinDir = (asin: string) => path.join(getEnv('OUT') || 'out', asin, 'pages')

  const parseArg = async (arg: string) => {
    const info = await mayStat(arg)
    if (info?.isFile()) {
      if (arg.endsWith(pageImageExt))
        return { one: arg }
      if (bookDirMetaFiles.includes(path.basename(arg)))
        return { all: path.join(path.dirname(arg), 'pages') }
    } else if (info?.isDirectory()) {
      // TODO check for "has any .png files" or "has info.json"
      return { all: path.join(arg, 'pages') }
    }
    return { all: asinDir(arg) }
  }

  await proc(async function*() {
    const args = process.argv.slice(2)

    if (args.length) {
      for (const arg of args) {
        const pa = await parseArg(arg)
        if (pa.one) {
          yield pa.one
        } else if (pa.all) {
          yield* await globby(`${pa.all}/*${pageImageExt}`)
        }
      }
    } else {
      const asin = getEnv('ASIN') || await input({ message: 'ASIN?' })
      assert(asin, 'ASIN is required')
      const pageFiles = await globby(`${asinDir(asin)}/*${pageImageExt}`)
      yield* pageFiles
    }
  }())
}

await main()
console.log('main fin')
