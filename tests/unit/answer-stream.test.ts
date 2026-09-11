// Requirements: PR-005, MR-005, AC-004（P5：token 级流式输出的答案抽取）
import { describe, expect, it } from "vitest";
import { AnswerStreamExtractor } from "@/src/modules/agent/domain/answer-stream";

/** 把一段完整 JSON 按给定分片切法喂进去，返回解出的文本与每次增量。 */
function feed(chunks: string[]) {
  const extractor = new AnswerStreamExtractor();
  const deltas = chunks.map((chunk) => extractor.push(chunk));
  return { text: extractor.snapshot(), deltas, status: extractor.status };
}

describe("P5 流式答案抽取", () => {
  it("逐字符流式解出 answer，增量拼接等于最终回答", () => {
    const payload = JSON.stringify({ answer: "接口延迟正在压缩灰度验证窗口。", skillsUsed: ["enterprise-analysis"] });
    const { text, deltas } = feed([...payload]);

    expect(text).toBe("接口延迟正在压缩灰度验证窗口。");
    expect(deltas.join("")).toBe(text);
  });

  it("分片边界落在键名/冒号/引号/正文中间都不影响结果", () => {
    const payload = JSON.stringify({ answer: "先缩小灰度范围，再观察 30 分钟。", skillsUsed: [] });
    const cuts = [[0, 3], [3, 11], [11, 12], [12, 20], [20, payload.length]];
    const extractor = new AnswerStreamExtractor();
    const pieces: string[] = [];
    let cursor = 0;
    for (const [from, to] of cuts) {
      if (from !== cursor) pieces.push(payload.slice(cursor, from));
      pieces.push(payload.slice(from, to));
      cursor = to;
    }
    pieces.push(payload.slice(cursor));
    for (const piece of pieces) extractor.push(piece);

    expect(extractor.snapshot()).toBe("先缩小灰度范围，再观察 30 分钟。");
  });

  it("转义序列跨分片时不吐半个字符", () => {
    const payload = JSON.stringify({ answer: "第一行\n第二行\t制表\\反斜杠\"引号", skillsUsed: [] });
    const extractor = new AnswerStreamExtractor();
    const deltas: string[] = [];
    // 逐字符喂：每个 `\` 与它的后续字符必然落在不同分片里。
    for (const char of payload) deltas.push(extractor.push(char));

    expect(extractor.snapshot()).toBe("第一行\n第二行\t制表\\反斜杠\"引号");
    expect(deltas.every((delta) => delta.length <= 1)).toBe(true);
  });

  it("unicode 转义（含代理对）能正确解码，且凑不齐时不提前输出", () => {
    // 手工构造带 \uXXXX 转义的载荷：JSON.stringify 不会把中文转义。
    const payload = '{"answer":"\\u4e2d\\ud83d\\ude00emoji","skillsUsed":[]}';
    const extractor = new AnswerStreamExtractor();
    const deltas: string[] = [];
    for (let index = 0; index < payload.length; index += 1) deltas.push(extractor.push(payload[index]));

    expect(extractor.snapshot()).toBe("中😀emoji");
    // 转义序列所在的分片本身不含解码后的字符（说明是凑齐后才输出的）。
    expect(payload).toContain("\\u4e2d");
    expect(deltas.slice(0, payload.indexOf("\\u4e2d") + 1).join("")).toBe("");
  });

  it("只认顶层 answer：嵌套结构里的同名键、其它键的字符串值都不会被当成回答", () => {
    const nested = JSON.stringify({ skillsUsed: ["answer"], detail: { answer: "这不是回答" }, answer: "这才是回答" });
    expect(feed([...nested]).text).toBe("这才是回答");

    const otherFirst = JSON.stringify({ reason: "answer", answer: "正文" });
    expect(feed([...otherFirst]).text).toBe("正文");
  });

  it("模型把 JSON 包在 ```json 代码块里也能抽出来", () => {
    const wrapped = "```json\n" + JSON.stringify({ answer: "代码块里的回答", skillsUsed: [] }) + "\n```";
    expect(feed([...wrapped]).text).toBe("代码块里的回答");
  });

  it("answer 出现在 skillsUsed 之后（字段顺序不固定）", () => {
    const reordered = JSON.stringify({ skillsUsed: ["meeting-preparation"], answer: "顺序无关" });
    expect(feed([...reordered]).text).toBe("顺序无关");
  });

  it("answer 不是字符串时放弃抽取，不抛错也不输出", () => {
    expect(feed([...JSON.stringify({ answer: null })]).text).toBe("");
    expect(feed([...JSON.stringify({ answer: 42 })]).text).toBe("");
    expect(feed([...JSON.stringify({ skillsUsed: [] })]).text).toBe("");
  });

  it("非法转义与截断的流不会崩，也不会输出半截内容", () => {
    expect(feed(['{"answer":"\\qbad"}']).text).toBe("");
    const truncated = new AnswerStreamExtractor();
    truncated.push('{"answer":"未写完');
    expect(truncated.snapshot()).toBe("未写完");
    expect(truncated.status).toBe("streaming");
  });

  it("状态机：抽到完整字符串后进入 done，后续分片不再输出", () => {
    const extractor = new AnswerStreamExtractor();
    extractor.push('{"answer":"完');
    expect(extractor.status).toBe("streaming");
    extractor.push('成","skillsUsed":[]}');
    expect(extractor.status).toBe("done");
    expect(extractor.snapshot()).toBe("完成");
    expect(extractor.push('{"answer":"第二段"}')).toBe("");
  });
});
