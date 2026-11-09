import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { extractPdfPages } from '../src/extract.ts'

describe('page-preserving PDF worker extraction', () => {
  it('keeps page numbers and input bytes while yielding the host event loop', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    for (const text of ['First page source', 'Second page source']) pdf.addPage().drawText(text, { x: 72, y: 700, font })
    const bytes = await pdf.save(), original = new Uint8Array(bytes)
    let eventLoopYielded = false
    const tick = new Promise<void>(resolve => setImmediate(() => { eventLoopYielded = true; resolve() }))
    const result = await extractPdfPages(bytes)
    expect(eventLoopYielded).toBe(true)
    await tick
    expect(result.total).toBe(2)
    expect(result.pages.map(page => page.num)).toEqual([1, 2])
    expect(result.pages[0]!.text).toContain('First page source')
    expect(result.pages[1]!.text).toContain('Second page source')
    expect(bytes).toEqual(original)
  })

  it('rejects invalid PDFs and PDFs exceeding the existing 50-page limit', async () => {
    await expect(extractPdfPages(new TextEncoder().encode('invalid PDF'))).rejects.toThrow()
    const pdf = await PDFDocument.create()
    for (let index = 0; index < 51; index++) pdf.addPage()
    await expect(extractPdfPages(await pdf.save())).rejects.toThrow('单份 PDF 不能超过 50 页')
  })
})
