/**
 * P5（token 级流式输出）：从**流式 JSON** 里增量抽出用户可见的回答文本。
 *
 * 为什么需要它：Agent 的模型调用要求结构化 JSON（`{"answer": "...", "skillsUsed": [...]}`，见
 * `finalAnswerSchema`），而且最终回答必须经服务端解析校验后才采纳。直接把原始流式片段丢给界面，
 * 用户会看到 `{"answer":"` 这种协议噪声，也等于把"未经校验的模型文本"当成答案展示。
 *
 * 这个抽取器只做一件事：在 JSON 流里定位**顶层 key `answer`** 的字符串值，把它的**转义序列解码后**
 * 的增量文本吐出来。它不校验语义、不保证 JSON 一定闭合——最终回答仍然由服务端的
 * `parseFinalAnswer` 决定；流式文本只是"正在生成"的预览，解析失败时界面会用服务端文案替换它。
 *
 * 边界（有意如此）：
 * - 只认顶层 `answer` 键（`depth === 1`）：嵌套对象里的同名键不会被误当成回答。
 * - 转义序列跨分片时不会漏字符也不会吐出半个字符（`\`、`\n`、`\u4e2d` 都会等到凑齐再解码）。
 * - 键名 `answer` 之前出现的字符串（例如 `"skillsUsed"`）不会被当成回答。
 * - 模型若把 JSON 包在 ```json 代码块里也能工作（扫描会跳过 `{` 之前的字符）。
 * - 非字符串的 `answer`（例如 `null`）直接放弃抽取，不抛错。
 */
export type AnswerStreamState = "seeking" | "awaiting_value" | "streaming" | "done";

const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

type StringRead = { value: string; end: number; terminated: boolean } | { malformed: true };

export class AnswerStreamExtractor {
  private raw = "";
  private cursor = 0;
  private depth = 0;
  private state: AnswerStreamState = "seeking";
  private text = "";

  /** 喂一段原始分片，返回本次新解出的回答文本（可能为空字符串）。 */
  push(chunk: string): string {
    if (!chunk) return "";
    this.raw += chunk;
    const before = this.text.length;
    this.advance();
    return this.text.slice(before);
  }

  /** 目前解出的完整回答文本（预览用）。 */
  snapshot(): string {
    return this.text;
  }

  get status(): AnswerStreamState {
    return this.state;
  }

  private advance(): void {
    while (this.state !== "done") {
      if (this.state === "seeking") {
        if (!this.scanSeeking()) return;
        continue;
      }
      if (this.state === "awaiting_value") {
        if (!this.awaitValue()) return;
        continue;
      }
      if (!this.streamAnswer()) return;
    }
  }

  /** 扫描到 `"answer"` 键与它的冒号；返回 true 表示状态已推进（可继续循环）。 */
  private scanSeeking(): boolean {
    while (this.cursor < this.raw.length) {
      const char = this.raw[this.cursor];
      if (char === "{") {
        this.depth += 1;
        this.cursor += 1;
        continue;
      }
      if (char === "}" || char === "]") {
        this.depth -= 1;
        this.cursor += 1;
        if (this.depth <= 0) { this.state = "done"; return false; }
        continue;
      }
      if (char === "[") {
        this.depth += 1;
        this.cursor += 1;
        continue;
      }
      if (char !== '"') {
        this.cursor += 1;
        continue;
      }
      const read = readJsonString(this.raw, this.cursor);
      if ("malformed" in read) { this.state = "done"; return false; }
      if (!read.terminated) return false;
      const afterString = skipWhitespace(this.raw, read.end + 1);
      if (afterString >= this.raw.length) return false;
      const isKey = this.raw[afterString] === ":";
      this.cursor = read.end + 1;
      if (!isKey) continue;
      if (read.value === "answer" && this.depth === 1) {
        this.state = "awaiting_value";
        this.cursor = afterString + 1;
        return true;
      }
      // 其它键：跳到值的位置继续扫。
      this.cursor = afterString + 1;
    }
    return false;
  }

  /** 等 `answer` 的值开始：只有字符串才继续流式输出。 */
  private awaitValue(): boolean {
    const next = skipWhitespace(this.raw, this.cursor);
    if (next >= this.raw.length) return false;
    if (this.raw[next] !== '"') {
      // answer 不是字符串（null/数字/对象）：放弃抽取，等最终解析结果。
      this.state = "done";
      return false;
    }
    this.cursor = next + 1;
    this.state = "streaming";
    return true;
  }

  /** 逐字符解码 answer 字符串，能解出一个字符就追加一个。 */
  private streamAnswer(): boolean {
    while (this.cursor < this.raw.length) {
      const char = this.raw[this.cursor];
      if (char === '"') {
        this.state = "done";
        this.cursor += 1;
        return false;
      }
      if (char !== "\\") {
        this.text += char;
        this.cursor += 1;
        continue;
      }
      const decoded = decodeEscape(this.raw, this.cursor);
      if (decoded === null) return false; // 转义序列还没凑齐，等下一个分片
      if (decoded === "malformed") { this.state = "done"; return false; }
      this.text += decoded.value;
      this.cursor = decoded.next;
    }
    return false;
  }
}

function skipWhitespace(value: string, from: number): number {
  let index = from;
  while (index < value.length && /\s/.test(value[index])) index += 1;
  return index;
}

/** 读取一个 JSON 字符串字面量（含转义解码）；未闭合时 terminated=false，语法错误时 malformed。 */
function readJsonString(value: string, start: number): StringRead {
  let index = start + 1;
  let result = "";
  while (index < value.length) {
    const char = value[index];
    if (char === '"') return { value: result, end: index, terminated: true };
    if (char !== "\\") {
      result += char;
      index += 1;
      continue;
    }
    const decoded = decodeEscape(value, index);
    if (decoded === null) return { value: result, end: index, terminated: false };
    if (decoded === "malformed") return { malformed: true };
    result += decoded.value;
    index = decoded.next;
  }
  return { value: result, end: value.length, terminated: false };
}

/** 解码 `\` 开头的转义；返回 null 表示当前分片还不够（等更多输入）。 */
function decodeEscape(value: string, start: number): { value: string; next: number } | "malformed" | null {
  const marker = value[start + 1];
  if (marker === undefined) return null;
  if (marker === "u") {
    const hex = value.slice(start + 2, start + 6);
    if (hex.length < 4) return null;
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return "malformed";
    const code = Number.parseInt(hex, 16);
    // 代理对：高代理后面必须紧跟 `\uXXXX`，凑不齐就等下一个分片。
    if (code >= 0xd800 && code <= 0xdbff) {
      const pairStart = start + 6;
      const pairMarker = value.slice(pairStart, pairStart + 2);
      // 低代理还没到：等下一个分片，不要误判成语法错误。
      if (pairMarker.length < 2) return null;
      if (pairMarker !== "\\u") return "malformed";
      const low = value.slice(pairStart + 2, pairStart + 6);
      if (low.length < 4) return null;
      if (!/^[0-9a-fA-F]{4}$/.test(low)) return "malformed";
      const lowCode = Number.parseInt(low, 16);
      if (lowCode < 0xdc00 || lowCode > 0xdfff) return "malformed";
      return { value: String.fromCodePoint(((code - 0xd800) << 10) + (lowCode - 0xdc00) + 0x10000), next: pairStart + 6 };
    }
    return { value: String.fromCharCode(code), next: start + 6 };
  }
  const simple = SIMPLE_ESCAPES[marker];
  if (simple === undefined) return "malformed";
  return { value: simple, next: start + 2 };
}
