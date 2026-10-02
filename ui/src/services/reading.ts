import { demoDocuments } from '@/mocks/reading';
import type { ReadingService } from '@/types';
import { mockService } from './mock';

export const mockReadingService: ReadingService = {
  async document(courseId, materialId) {
    const data = await mockService.load();
    const material = data.courses.find(c => c.id === courseId)?.materials.find(m => m.id === materialId);
    if (!material) throw new Error('资料不存在，请重新选择。');
    const demo = demoDocuments[materialId];
    return { id: material.id, name: material.name, title: demo?.title ?? material.name.replace(/\.[^.]+$/, ''), content: material.content ?? demo?.content ?? '', source: material.content !== undefined ? 'local' : demo ? 'demo' : 'unavailable' };
  },
  async assist(document, selection, mode) {
    await new Promise(resolve => setTimeout(resolve, 450));
    let explanation = '先把选中的这段话拆成「对象、条件、结论」三部分，再结合它前后的例子理解。尝试用自己的话复述，并检查是否遗漏了限定条件。';
    if (/线性相关|线性无关|独立方向/.test(selection)) explanation = '把向量想成空间中的箭头。如果某个箭头可以由其他箭头缩放、相加得到，它就没有带来新的独立方向，这组向量线性相关。\n\n例如 b = 2a，那么 2a − b = 0，系数不全为零。这就是直观描述对应的代数条件。线性无关则要求只有全部系数为零，线性组合才会得到零向量。';
    else if (/维数|基|张成/.test(selection)) explanation = '基可以理解为描述整个空间所需的最少一组独立方向。它必须同时满足两个条件：能组合出空间中的所有向量，而且自身没有冗余。\n\n基中向量的个数就是维数。给二维平面再加一个能由原有基组合得到的向量，并不会增加维数。';
    else if (/条件概率|样本空间|1\/3/.test(selection)) explanation = '条件概率先根据已经知道的信息缩小观察范围，再在这个范围内计算目标事件的比例。\n\n例如两次抛硬币，已知至少一次正面，剩下正正、正反、反正三个等可能结果，其中一个满足两次正面，所以概率是 1/3。';
    else if (/return|print|返回值|None/.test(selection)) explanation = 'return 负责把结果返回给调用函数的代码，并结束当前函数。print 只把内容显示出来。\n\n如果函数里只有 print 而没有 return，调用者得到的返回值仍然是 None。可以把函数调用赋值给一个变量来观察区别。';
    const paragraphs = document.content.split(/\n\s*\n/).filter(p => !p.startsWith('#'));
    const keyword = ['线性相关', '线性无关', '维数', '基', '条件概率', '随机变量', 'return', 'print'].find(k => selection.includes(k));
    const exact = paragraphs.filter(p => p.includes(selection) || (keyword && p.includes(keyword)));
    const matches = (exact.length ? exact : paragraphs).slice(0, 3).map((excerpt, index) => ({ title: `${document.title} · 相关段落 ${index + 1}`, excerpt }));
    return { mode, selection, explanation, matches };
  },
};
