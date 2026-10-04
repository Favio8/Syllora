import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import MarkdownView from "../src/components/chat/MarkdownView";

afterEach(() => { cleanup(); });

const matrix = String.raw`设 $A=\begin{pmatrix}1&2\\3&4\end{pmatrix}$，则行列式：

$$\det A = 1\cdot4-2\cdot3=-2$$`;

describe("公式渲染（KaTeX）", () => {
  it("把行内与块级公式渲染成 KaTeX 节点，不再原样显示 LaTeX", () => {
    const { container } = render(<MarkdownView content={matrix} />);
    // 行内公式 + 单行 $$…$$（经归一化折成块级）都要渲染成 KaTeX 节点。
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".katex-display")).not.toBeNull();
    // 定界符已被消费：可见文本里不再出现裸的 $（LaTeX 原文只留在 MathML 注解里，
    // 那是 KaTeX 为无障碍/复制保留的，不是可见文本）。
    expect(container.querySelector("p")?.textContent ?? "").not.toContain("$");
    expect(container.querySelector(".katex-html")?.textContent ?? "").not.toContain("\\begin{pmatrix}");
  });

  it("写坏的公式不炸整条消息（throwOnError=false）", () => {
    const { container } = render(<MarkdownView content={"$\\frac{1}{$ 后面还有正文"} />);
    expect(container.textContent ?? "").toContain("后面还有正文");
  });
});

it('keeps inline code and nested fence examples literal when normalizing math', () => {
  const { container } = render(<MarkdownView content={'`\\(literal\\)`\n\n````markdown\n```js\n$$literal$$\n```\n````\n\n\\[\nx^2\n\\]'} />);
  expect(container.querySelectorAll('.katex-display')).toHaveLength(1);
  expect(container.querySelector('pre')?.textContent).toContain('$$literal$$');
  expect(container.querySelector('code')?.textContent).toBe('\\(literal\\)');
});
