import 'dotenv/config'

import { createHash } from 'node:crypto'

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  input,
  password,
} from '@inquirer/prompts'

import delay from 'delay'
import { type Locator } from 'playwright'

import * as playwright from 'playwright'

import {
  assert,
  deromanize,
  getEnv,
  maybeURL,
  niceOpen,
  normalizeAuthors,
  parseJsonpResponse,
  withDefer,
} from './utils'

interface PageNav {
  page?: number
  location?: number
  total: number
}

interface TocEntry extends PageNav {
  title: string
}

interface TocItem extends TocEntry {
  locator?: Locator
}

async function main() {
  const argASIN = (arg: string): string => {
    const url = maybeURL(arg)
    if (url) {
      const param = url.searchParams.get('asin')
      if (param) return param
      throw new Error(`missing asin param in {arg}`)
    }
    return arg
  }

  const args = process.argv.slice(2)
  if (args.length > 1) {
    for (const arg of args)
      await proc({ asin: argASIN(arg) })
  } else if (args.length == 1) {
    return proc({ asin: argASIN(args[0]!) })
  } else {
    const asin = getEnv('ASIN') || await input({ message: 'ASIN?' })
    assert(asin, 'ASIN is required')
    return proc({ asin })
  }
}

const browserConfigDefaults = {
  chromium: {
    // channel: 'chrome',
    // executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--hide-crash-restore-bubble'],
    ignoreDefaultArgs: ['--enable-automation'],
  },
  firefox: {
  },
  webkit: {
  },
}

function proc(options: {
  asin: string,
  readUrl?: string,

  outDir?: string,
  bookDir?: string,
  browserDataDir?: string,

  screenshotSize?: { width: number, height: number },
  browserHeadless?: boolean,
  browserType?: 'chromium' | 'firefox' | 'webkit',
  browserTimeout?: number,
}) {
  const {
    asin,
    readUrl = `https://read.amazon.com/?asin=${asin}`,

    outDir = getEnv('OUT') || 'out',
    bookDir = path.join(outDir, asin),
    browserDataDir = path.join(bookDir, 'data'),

    screenshotSize = { width: 1280, height: 720 }, // TODO env parse
    browserHeadless = false, // TODO env parse
    browserType = 'chromium', // TODO env parse
    browserTimeout = 30_000, // TODO env parse
  } = options

  // TODO switch to a leveled logger; maybe tee stdout into book/log, but maybe just leave that up to externalities

  // TODO option hookup + env
  const browserConfig = browserConfigDefaults[browserType]

  const resHandlers: Array<(url: URL, res: playwright.Response) => Promise<void> | null | undefined> = [

    // info json
    (url, res) => {
      if (url.hostname !== 'read.amazon.com') return
      if (url.pathname !== '/service/mobile/reader/startReading') return
      const infoAsin = url.searchParams.get('asin')
      if (infoAsin?.toLowerCase() !== asin.toLowerCase()) {
        console.error('info asin mismatch', { expected: asin, got: infoAsin })
        return null
      }
      return writeBookFile('info.json', async file => {
        let text = await res.text()
        try {
          const body: any = JSON.parse(text)
          delete body.karamelToken
          delete body.kindleSessionId
          delete body.metadataUrl
          delete body.YJFormatVersion
          text = JSON.stringify(body, null, 2)
        } catch (err) {
          console.error('failed to cleanse info JSON', err)
        }
        return file.writeFile(text)
      })
    },

    // metadata json
    (url, res) => {
      // TODO hostname check
      if (!url.pathname.endsWith('YJmetadata.jsonp')) return
      console.log('metadata hostname:', url.hostname)

      return writeBookFile('metadata_raw.json', async file => {
        const body = await res.text()
        return Promise.all([
          file.writeFile(body),

          writeBookFile('metadata.json', async file => {
            const metadata = parseJsonpResponse<any>(body)
            if (metadata.asin.toLowerCase() !== asin.toLowerCase()) {
              console.error('metadata asin mismatch', { expected: asin, got: metadata.asin })
              return
            }

            delete metadata.cpr
            if (Array.isArray(metadata.authorsList)) {
              metadata.authorsList = normalizeAuthors(metadata.authorsList)
            }

            return file.writeFile(JSON.stringify(metadata, null, 2))
          })
        ]).then(() => { })
      })
    },

    // ignore telemetry
    url => {
      if (
        url.pathname == '/reader/uploadMetrics' ||
        url.pathname.startsWith('/1/events/com.amazon.eel.')
      ) return null
    },

    // ignore frontend assets
    (_url, res) => {
      const contentType = res.headers()['content-type']?.replace(/\s*;.*$/, '')
      if (
        contentType === 'text/css' ||
        contentType === 'application/x-javascript' ||
        contentType?.startsWith('image/')
      ) return null
    },

    // resource key data
    (url, res) => {
      // TODO hostname check
      const match = /^\/([^\/]+)\/([^\/]+)\/fullbook\/resource\/(.+)$/.exec(url.pathname)
      if (!match) return
      console.log('fullbook resource hostname:', url.hostname)

      const [got, revision, id] = match
      if (got.toLowerCase() != asin.toLowerCase()) {
        console.error('resource asin mismatch', { expected: asin, got })
        return null
      }

      return writeBookFile(
        path.join(`resource_${revision!}`, id!),
        async file => file.writeFile(await res.body()))
    },

    // renderer tarballs
    (url, res) => {
      // TODO hostname check
      if (url.pathname !== '/renderer/render') return
      console.log('render hostname:', url.hostname)

      const renderAsin = url.searchParams.get('asin')
      if (renderAsin !== asin) {
        console.error('render asin mismatch', { expected: asin, got: renderAsin })
        return null
      }

      const contentType = res.headers()['content-type']?.replace(/\s*;.*$/, '')
      if (contentType !== 'application/x-tar') {
        console.error('render non-tar content', { expected: 'application/x-tar', got: contentType })
        return null
      }

      const { take, hash } = makeParamsHash(url.searchParams)
      const kind = take('contentType')
      const pages = take('numPage')
      const skip = take('skipPageCount')
      const start = take('startingPosition')

      return writeBookFile(
        path.join(`render_${kind}`, hash().digest('hex'), `${start}_${skip}_${pages}.tar`),
        async file => file.writeFile(await res.body()))
    },

    // info log fallthrough for development
    (url, res) => {
      const contentType = res.headers()['content-type']?.replace(/\s*;.*$/, '')
      console.log('response', contentType, url.href)
      return undefined
    },

  ]

  async function writeBookFile<T>(name: string, withFile: (file: fs.FileHandle) => Promise<T>) {
    const filename = path.join(bookDir, name)
    return withDefer(async defer => {
      const file = (await niceOpen(filename, 'w'))!
      defer(() => file.close())

      const ret = await withFile(file)
      console.log(`saved ${filename}`)
      return ret
    })
  }

  async function readBookFile<T>(name: string, withFile: (file: fs.FileHandle) => Promise<T | null>) {
    const filename = path.join(bookDir, name)
    return withDefer(async defer => {
      const file = await niceOpen(filename, 'r')
      if (!file) return null
      defer(() => file.close())
      return withFile(file)
    })
  }

  return withDefer(async defer => {
    await fs.writeFile(path.join(bookDir, 'read.url'), readUrl)

    await fs.mkdir(browserDataDir, { recursive: true })
    const browser = await playwright[browserType].launchPersistentContext(browserDataDir, {
      ...browserConfig,
      headless: browserHeadless,
      deviceScaleFactor: 2,
      viewport: screenshotSize
    })
    defer(() => browser.close())

    const browserPage = await browser.newPage()
    defer(() => browserPage.close())

    // TODO browserPage.on('crash'
    // TODO browserPage.on('download'
    // TODO browserPage.on('pageerror'
    // TODO browserPage.on('close'

    browserPage.on('response', async response => {
      if (!response.ok()) return
      const url = new URL(response.url())
      for (const handle of resHandlers) {
        const match = handle(url, response)
        if (match === null) return
        await match
      }
    })

    async function doSignin() {
      await Promise.any([
        browserPage.goto(readUrl, { timeout: browserTimeout }),
        browserPage.waitForURL('**/ap/signin', { timeout: browserTimeout })
      ])

      if (/\/ap\/signin/g.test(new URL(browserPage.url()).pathname)) {
        // TODO secret service? bitwarden integration?
        const amazonEmail = getEnv('AMAZON_EMAIL') || await input({ message: 'Amazon Email?' })
        assert(amazonEmail, 'AMAZON_EMAIL is required')

        const amazonPassword = getEnv('AMAZON_PASSWORD') || await password({ message: 'Amazon Password?' })
        assert(amazonPassword, 'AMAZON_PASSWORD is required')

        await browserPage.locator('input[type="email"]').fill(amazonEmail)
        await browserPage.locator('input[type="submit"]').click()

        await browserPage.locator('input[type="password"]').fill(amazonPassword)
        // await browserPage.locator('input[type="checkbox"]').click()
        await browserPage.locator('input[type="submit"]').click()

        if (!/\/kindle-library/g.test(new URL(browserPage.url()).pathname)) {
          console.warn('need 2fa for', browserPage.url())
          const code = await input({
            message: 'Amazon 2-factor auth code?'
          })

          // Only enter 2-factor auth code if needed
          if (code) {
            await browserPage.locator('input[type="tel"]').fill(code)
            await browserPage
              .locator(
                'input[type="submit"][aria-labelledby="cvf-submit-otp-button-announce"]'
              )
              .click()
          }
        }

        if (!browserPage.url().includes(readUrl)) {
          await browserPage.goto(readUrl)

          // browserPage.waitForURL('**/kindle-library', { timeout: pageWait })
          // await browserPage.locator(`#title-${asin}`).click()
        }
      }
    }

    async function updateSettings() {
      await browserPage.locator('ion-button[title="Reader settings"]').click()
      await delay(1000)

      // Change font to Amazon Ember
      await browserPage.locator('#AmazonEmber').click()

      // Change layout to single column
      await browserPage
        .locator('[role="radiogroup"][aria-label$=" columns"]', {
          hasText: 'Single Column'
        })
        .click()

      await browserPage.locator('ion-button[title="Reader settings"]').click()
      await delay(1000)
    }

    async function goToPage(pageNumber: number) {
      await delay(1000)
      await browserPage.locator('#reader-header').hover({ force: true })
      await delay(200)
      await browserPage.locator('ion-button[title="Reader menu"]').click()
      await delay(1000)
      await browserPage
        .locator('ion-item[role="listitem"]', { hasText: 'Go to Page' })
        .click()
      await browserPage
        .locator('ion-modal input[placeholder="page number"]')
        .fill(`${pageNumber}`)
      // await browserPage.locator('ion-modal button', { hasText: 'Go' }).click()
      await browserPage
        .locator('ion-modal ion-button[item-i-d="go-to-modal-go-button"]')
        .click()
      await delay(1000)
    }

    async function getPageNav() {
      const footerText = await browserPage
        .locator('ion-footer ion-title')
        .first()
        .textContent()
      return parsePageNav(footerText)
    }

    async function ensureFixedHeaderUI() {
      await browserPage.locator('.top-chrome').evaluate((el) => {
        el.style.transition = 'none'
        el.style.transform = 'none'
      })
    }

    async function dismissPossibleAlert() {
      const $alertNo = browserPage.locator('ion-alert button', { hasText: 'No' })
      if (await $alertNo.isVisible()) {
        $alertNo.click()
      }
    }

    async function makePageReset() {
      const pageNav = await getPageNav()
      return async () => {
        const page = pageNav?.page
        if (page !== undefined) {
          console.warn(`resetting back to initial page ${page}...`)
          await goToPage(page)
        }
      }
    }

    function assertViewportSize() {
      const size = browserPage.viewportSize()
      assert(
        size?.width == screenshotSize.width &&
        size?.height == screenshotSize.height)
    }

    async function readerInit() {
      await doSignin()
      await dismissPossibleAlert()
      await ensureFixedHeaderUI()
      await updateSettings()
    }

    await readerInit()
    assertViewportSize()
    defer(await makePageReset())

    async function* tocLocators() {
      await browserPage.locator('ion-button[title="Table of Contents"]').click()
      await delay(1000)
      for (const locator of await browserPage.locator('ion-list ion-item').all()) {
        await locator.scrollIntoViewIfNeeded()
        yield locator
      }
    }

    async function* extractTocItems() {
      for await (const locator of tocLocators()) {
        const title = await locator.textContent()
        assert(title)

        await locator.click()
        await delay(250)

        const pageNav = await getPageNav()
        assert(pageNav)

        yield { locator, title, ...pageNav }
      }
    }

    const tocItems = (await readBookFile('toc.json', async file => {
      const tocEntries: Array<TocEntry> = []
      for await (const line of file.readLines()) {
        const entry = JSON.parse(line)
        // TODO generic validation library worth?
        assert(typeof entry === 'object' && entry !== null)
        assert('title' in entry && typeof entry.title === 'string')
        assert('total' in entry && typeof entry.total === 'number')
        if ('page' in entry) assert(typeof entry.page === 'number')
        if ('location' in entry) assert(typeof entry.location === 'number')
        tocEntries.push(entry as TocEntry)
        console.log('read toc', entry)
      }

      const tocItems: Array<TocItem> = []

      const byTitle = new Map(tocEntries.map(ent => [ent.title, ent]))
      let anyMissing = false
      for await (const locator of tocLocators()) {
        const title = await locator.textContent()
        assert(title)

        const ent = byTitle.get(title)
        if (!ent) {
          anyMissing = true
          continue
        }

        const tocItem = { locator, ...ent }
        tocItems.push(tocItem)
        console.log('found toc', tocItem)
      }

      if (anyMissing) {
        console.log('toc is incomplete, will re-extract')
        return null
      }

      return tocItems
    })) || (await writeBookFile(path.join(bookDir, 'toc.json'), async file => {
      const tocItems: Array<TocItem> = []

      console.log('Extracting toc items')
      for await (const tocItem of extractTocItems()) {
        // TODO y tho
        if (tocItem.page !== undefined && tocItem.page >= tocItem.total) break

        tocItems.push(tocItem)

        const { locator, ...tocEntry } = tocItem

        const ent = JSON.stringify(tocEntry)
        await file.write(`${ent}\n`)
        console.log('extracted toc', ent)
      }

      return tocItems
    }))!

    await writeBookFile('pages.json', async pagesFile => {

      // TODO why elide head/tail matter ; restore, at least optionally
      const { firstPageTocItem, afterLastPageTocItem } = parseTocItems(tocItems)

      const total = firstPageTocItem.total
      const pagePadding = `${total * 2}`.length

      await firstPageTocItem.locator!.scrollIntoViewIfNeeded()
      await firstPageTocItem.locator!.click()

      const totalContentPages = afterLastPageTocItem?.page
        ? Math.min(total, afterLastPageTocItem.page)
        : total
      assert(totalContentPages > 0, 'No content pages found')

      await browserPage.locator('.side-menu-close-button').click()
      await delay(1000)

      let index = 0
      console.warn(
        `reading ${totalContentPages} pages${total > totalContentPages ? ` (of ${total} total pages stopping at "${afterLastPageTocItem!.title}")` : ''}...`
      )

      const render = browserPage.locator('#kr-renderer .kg-full-page-img img')
      const nextPage = browserPage.locator('.kr-chevron-container-right')

      do {
        assertViewportSize()

        const pageNav = await getPageNav()
        if (pageNav?.page === undefined) {
          const url = browserPage.url().includes(readUrl)
          console.error('lost page navigation', url)
          // TODO do we need to re-signin?
          // await readerInit()
          // continue XXX re-signin-attempt-limit
          break
        }
        const { page, total } = pageNav
        if (page > totalContentPages) break

        const src = await render.getAttribute('src')
        const b = await render.screenshot({ type: 'png', scale: 'css' })

        const ix = `${index}`.padStart(pagePadding, '0')
        const pg = `${page}`.padStart(pagePadding, '0')
        const name = path.join('pages', `${ix}-${pg}.png`)

        await writeBookFile(name, file => file.writeFile(b))

        const pageEnt = { index, page, total, screenshot: name }
        const ent = JSON.stringify(pageEnt)
        await pagesFile.write(`${ent}\n`)
        index++
        console.warn(ent)

        // Navigation is very spotty without this delay; I think it may be due to
        // the screenshot changing the DOM temporarily and not being stable yet.
        await delay(100)

        let retries = 0

        // Occasionally the next page button doesn't work, so ensure that the main
        // image src actually changes before continuing.
        do {
          try {
            // Navigate to the next page
            // await delay(100)
            if (retries % 10 === 0) {
              if (retries > 0)
                console.warn('retrying...', { src, retries, ...pageEnt })

              await nextPage.click({ timeout: 1000 })
            }
            // await delay(500)
          } catch (err) {
            // No next page to navigate to
            console.error('unable to navigate to next page; breaking...', err)
            return
          }

          const newSrc = await render.getAttribute('src')
          if (newSrc !== src) break
          if (page >= totalContentPages) break

          await delay(100)

          ++retries
        } while (true)

      } while (true)

    })

  })
}

function parsePageNav(text: string | null): PageNav | undefined {
  {
    // Parse normal page locations
    const match = text?.match(/page\s+(\d+)\s+of\s+(\d+)/i)
    if (match) {
      const page = Number.parseInt(match?.[1]!)
      const total = Number.parseInt(match?.[2]!)
      if (Number.isNaN(page) || Number.isNaN(total)) {
        return undefined
      }

      return { page, total }
    }
  }

  {
    // Parse locations which are not part of the main book pages
    // (toc, copyright, title, etc)
    const match = text?.match(/location\s+(\d+)\s+of\s+(\d+)/i)
    if (match) {
      const location = Number.parseInt(match?.[1]!)
      const total = Number.parseInt(match?.[2]!)
      if (Number.isNaN(location) || Number.isNaN(total)) {
        return undefined
      }

      return { location, total }
    }
  }

  {
    // Parse locations which use roman numerals
    const match = text?.match(/page\s+([cdilmvx]+)\s+of\s+(\d+)/i)
    if (match) {
      const location = deromanize(match?.[1]!)
      const total = Number.parseInt(match?.[2]!)
      if (Number.isNaN(location) || Number.isNaN(total)) {
        return undefined
      }

      return { location, total }
    }
  }
}

function parseTocItems(tocItems: TocItem[]) {
  // Find the first page in the TOC which contains the main book content
  // (after the title, table of contents, copyright, etc)
  const firstPageTocItem = tocItems.find((item) => item.page !== undefined)
  assert(firstPageTocItem, 'Unable to find first valid page in TOC')

  // Try to find the first page in the TOC after the main book content
  // (e.g. acknowledgements, about the author, etc)
  const afterLastPageTocItem = tocItems.find((item) => {
    if (item.page === undefined) return false
    if (item === firstPageTocItem) return false

    const percentage = item.page / item.total
    if (percentage < 0.9) return false

    if (/acknowledgements/i.test(item.title)) return true
    if (/^discover more$/i.test(item.title)) return true
    if (/^extras$/i.test(item.title)) return true
    if (/about the author/i.test(item.title)) return true
    if (/meet the author/i.test(item.title)) return true
    if (/^also by /i.test(item.title)) return true
    if (/^copyright$/i.test(item.title)) return true
    if (/ teaser$/i.test(item.title)) return true
    if (/ preview$/i.test(item.title)) return true
    if (/^excerpt from/i.test(item.title)) return true
    if (/^cast of characters$/i.test(item.title)) return true
    if (/^timeline$/i.test(item.title)) return true
    if (/^other titles/i.test(item.title)) return true

    return false
  })

  return {
    firstPageTocItem,
    afterLastPageTocItem
  }
}

function makeParamsHash(params: Iterable<[key: string, val: string]>) {
  const pm = new Map(params)
  const take = (key: string) => {
    const val = pm.get(key)
    pm.delete(key)
    return val
  }
  const hash = (algorithm: string = 'md5') => {
    const ph = createHash(algorithm)
    for (const [key, val] of pm) {
      ph.update("\0")
      ph.update(key)
      ph.update("\0")
      ph.update(val)
    }
    return ph
  }
  return { take, hash }
}

await main()
