import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { globby } from 'globby'
import pMap from 'p-map'

import {
  input,
} from '@inquirer/prompts'

import {
  assert,
  getEnv,
  mayStat,
  niceOpen,
  withDefer,
} from './utils'

import { OpenAIClient } from 'openai-fetch'
import { ollamaOCR, DEFAULT_OCR_SYSTEM_PROMPT } from 'ollama-ocr'

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

function makeOllamaTranscriber(model?: string) {
  if (!model) model = undefined
  // TODO support custom prompt env hookup?
  return async function transcribe(filePath: string) {
    return ollamaOCR({
      filePath,
      model,
      systemPrompt: DEFAULT_OCR_SYSTEM_PROMPT
    })
  }
}

// TODO support markdown mode
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

const pageImageExt = '.png'

async function proc(pageFiles: AsyncIterable<string>) {
  const concurrency = parseInt(getEnv('TRANSCRIBE_CONC') || '1')

  const method = getEnv('TRANSCRIBER') || 'ollama'
  const transcribe = makeTranscriber(method)

  await pMap(pageFiles, async pageFile => {
    try {
      const textFile = path.join(
        path.dirname(pageFile),
        `${path.basename(pageFile, pageImageExt)}.txt`)
      console.log('transcribing', pageFile)
      const text = await transcribe(pageFile)
      await writeFile(textFile, file => file.writeFile(text))
      console.log('saved', textFile)

    } catch (err) {
      console.error(`error transcribing ${pageFile}`, err)
    }
  }, { concurrency })
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

  const args = process.argv.slice(2)
  if (args.length) {
    await proc(async function*() {
      for (const arg of args) {
        const pa = await parseArg(arg)
        if (pa.one) {
          yield pa.one
        } else if (pa.all) {
          yield* await globby(`${pa.all}/*${pageImageExt}`)
        }
      }
    }())
  } else {
    const asin = getEnv('ASIN') || await input({ message: 'ASIN?' })
    assert(asin, 'ASIN is required')
    return proc(async function*() {
      const pageFiles = await globby(`${asinDir(asin)}/*${pageImageExt}`)
      yield* pageFiles
    }())
  }
}

await main()
