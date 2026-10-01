/** Deterministic, explicitly synthetic model response used only by browser acceptance. */
export function fixtureLecture(sources:Array<{id:string;text:string}>,sourceId:string) {
  if(!sources.some(s=>s.text.includes('单位矩阵的主对角线元素为 1')))return {chapter:'PDF 原资料',intro:{text:'这是本地自动化测试模型的 PDF 导读。',sourceIds:sources.map(s=>s.id)},concepts:[{name:'PDF 测试正文',text:'以下为自动化预览验证所用正文。',quote:sources[0]!.text.trim().slice(0,80),sourceIds:[sources[0]!.id]}],examples:[],connections:[],analogies:[]}
  return {chapter:'矩阵与线性变换',intro:{text:'这是本地自动化测试模型整理的章节导读。',sourceIds:sources.map(s=>s.id)},concepts:[{name:'单位矩阵',text:'单位矩阵的主对角线元素为 1，其余元素为 0。',quote:'单位矩阵的主对角线元素为 1',sourceIds:[sourceId]}],examples:[],connections:[],analogies:[]}
}
/** Small valid, uncompressed ASCII PDF fixture; no external PDF test dependency. */
export function fixturePdf(pages:string[]):Buffer {
  if(!pages.length||pages.some(text=>/[^\x20-\x7e]/.test(text)))throw new Error('PDF fixture requires ASCII text and at least one page')
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_,i)=>`${4+i*2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  pages.forEach((text,i)=>{
    const escaped=text.replace(/[\\()]/g,c=>'\\'+c),stream=`BT /F1 12 Tf 40 700 Td (${escaped}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`,`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
  })
  let body='%PDF-1.4\n';const offsets=[0]
  objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${object}\nendobj\n`})
  const xref=Buffer.byteLength(body)
  body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body)
}
