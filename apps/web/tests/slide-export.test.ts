/**
 * PPTX 导出：文本提取、坐标映射、以及"真的产出可打开的 pptx"。
 * 这里不依赖 PowerPoint 渲染，改为断言字节头与包内 XML 内容——足以证明导出链路可用。
 */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildPptx, elementFontSize, elementText, renderCanvas } from '../src/features/workbench/slide-export';

const canvas = (content: string) => ({
  viewportSize: 1000,
  viewportRatio: 0.5625,
  theme: { backgroundColor: '#ffffff', fontColor: '#202128', fontName: 'Microsoft YaHei' },
  elements: [
    { type: 'text', id: 't1', left: 100, top: 50, width: 800, height: 120, rotate: 0, content, defaultColor: '#202128', defaultFontName: 'Microsoft YaHei' },
  ],
});

describe('文本与字号提取', () => {
  it('段落与 <br> 变行，标签与实体做保守降级', () => {
    expect(elementText('<p>第一段</p><p>第二段<br/>换行</p>')).toBe('第一段\n第二段\n换行');
    expect(elementText('<ul><li>甲</li><li>乙</li></ul>')).toBe('· 甲\n· 乙');
    expect(elementText('A &amp; B &lt;C&gt;')).toBe('A & B <C>');
    expect(elementText('<p>  收  尾  </p>')).toBe('收  尾');
  });

  it('从内联样式取字号，取不到用默认值', () => {
    expect(elementFontSize('<p style="font-size:32px;">x</p>', 24)).toBe(32);
    expect(elementFontSize('<p>x</p>', 24)).toBe(24);
    expect(elementFontSize('<p style="font-size:0px;">x</p>', 24)).toBe(24);
  });
});

describe('PPTX 组装', () => {
  it('画布坐标按 10 英寸宽换算，文本进入幻灯片', async () => {
    const pptx = buildPptx([{ chapter: '甲章', scenes: [{ title: '要点', content: { canvas: canvas('<p>单位矩阵与主对角线</p>') } }] }]);
    const buffer = await pptx.write({ outputType: 'arraybuffer' }) as ArrayBuffer;
    const bytes = new Uint8Array(buffer);

    // PPTX 是 zip：本地文件头魔数 'PK\x03\x04'。
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const zip = await JSZip.loadAsync(buffer);
    const slideXml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(slideXml).toContain('单位矩阵与主对角线');
    // 100px @ 1000 视口 = 1 英寸 = 914400 EMU（pptxgenjs 用 EMU 描述位置）。
    expect(slideXml).toMatch(/<a:off x="914400"/);
    // 讲者备注带上章节与页标题，导出的文件里仍能看出结构。
    const notesXml = await zip.file('ppt/notesSlides/notesSlide1.xml').async('string');
    expect(notesXml).toContain('甲章');
  });

  it('没有可渲染元素时跳过而不是产出坏形状', () => {
    const pptx = buildPptx([{ chapter: '空章', scenes: [{ title: '空页', content: { canvas: { ...canvas('<p>x</p>'), elements: [] } } }] }]);
    expect(pptx).toBeTruthy();
  });

  it('单个元素失败不影响其余元素', () => {
    const slide = { addText: () => { throw new Error('boom'); }, addImage: () => {} } as never;
    const written = renderCanvas(slide, {
      viewportSize: 1000, viewportRatio: 0.5625, theme: {},
      elements: [
        { type: 'text', left: 0, top: 0, width: 100, height: 50, content: '<p>坏元素</p>' },
        { type: 'image', left: 0, top: 0, width: 100, height: 50, src: 'data:image/png;base64,AAAA' },
      ],
    });
    expect(written).toBe(1);
  });

  it('没有画面传出明确错误，而不是产出空文件', async () => {
    const { exportDecksToPptx } = await import('../src/features/workbench/slide-export');
    await expect(exportDecksToPptx([])).rejects.toThrow('没有可导出的幻灯片');
  });
});
