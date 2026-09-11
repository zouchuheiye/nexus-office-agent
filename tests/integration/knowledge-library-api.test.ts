// Requirements: PR-004, MR-006, SR-002, AC-012（E-161：企业信息库 HTTP 契约）
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as listLibrary, POST as publishText } from "@/app/api/v1/knowledge/documents/route";
import { POST as uploadFile } from "@/app/api/v1/knowledge/documents/files/route";
import { GET as describeDocument } from "@/app/api/v1/knowledge/documents/[id]/route";
import { POST as appendVersion } from "@/app/api/v1/knowledge/documents/[id]/versions/route";
import { GET as downloadVersion } from "@/app/api/v1/knowledge/documents/[id]/versions/[version]/content/route";
import { POST as switchIdentity } from "@/app/api/v1/auth/development-identities/switch/route";

const secret = "0123456789abcdef0123456789abcdef";
const pdf = () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);

function sessionFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(/nexus_session=([^;]+)/);
  if (!match) throw new Error("session cookie missing");
  return decodeURIComponent(match[1]);
}

async function identityCookie(key: string): Promise<string> {
  const switched = await switchIdentity(new Request("http://localhost/api/v1/auth/development-identities/switch", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }),
  }));
  expect(switched.status).toBe(200);
  return sessionFrom(switched);
}

function multipart(fields: Record<string, string>, file?: { name: string; type: string; bytes: Uint8Array }, cookie?: string) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  if (file) form.set("file", new File([file.bytes as unknown as BlobPart], file.name, { type: file.type }));
  const headers: Record<string, string> = { "x-trace-id": "knowledge-library-api-test" };
  if (cookie) headers.cookie = `nexus_session=${encodeURIComponent(cookie)}`;
  return new Request("http://localhost/api/v1/knowledge/documents/files", { method: "POST", headers, body: form });
}

function jsonRequest(url: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-trace-id": "knowledge-library-api-test" };
  if (cookie) headers.cookie = `nexus_session=${encodeURIComponent(cookie)}`;
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

function getRequest(url: string, cookie?: string) {
  const headers: Record<string, string> = { "x-trace-id": "knowledge-library-api-test" };
  if (cookie) headers.cookie = `nexus_session=${encodeURIComponent(cookie)}`;
  return new Request(url, { headers });
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function setup() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("SESSION_SECRET", secret);
  vi.stubEnv("DATABASE_URL", "");
  // 契约测试不落盘：用内存实现验证链路与状态码。
  vi.stubEnv("NEXUS_FILE_STORAGE_PROVIDER", "memory");
  return identityCookie("manager");
}

describe("企业信息库 HTTP 契约（E-161）", () => {
  it("上传 → 列表 → 详情 → 下载：字节与摘要一致，文件名与类型透传", async () => {
    const cookie = await setup();
    const uploaded = await uploadFile(multipart({
      title: "实习生协议（2026 版）", category: "agreement", classification: "internal",
      summary: "三方实习协议模板。", allowedPositionNames: "HRBP,招聘专员",
    }, { name: "intern-2026.pdf", type: "application/pdf", bytes: pdf() }, cookie));
    expect(uploaded.status).toBe(201);
    const created = (await uploaded.json()).data;
    expect(created.document).toMatchObject({ kind: "file", category: "agreement", currentVersion: 1 });
    expect(created.version).toMatchObject({ fileName: "intern-2026.pdf", mediaType: "application/pdf", sizeBytes: pdf().byteLength });

    const listed = await (await listLibrary(getRequest("http://localhost/api/v1/knowledge/documents?category=agreement", cookie))).json();
    expect(listed.data.documents.map((item: { id: string }) => item.id)).toContain(created.document.id);
    expect(listed.data.documents[0].applicableTo.positions).toEqual(["HRBP", "招聘专员"]);

    const detail = await (await describeDocument(getRequest(`http://localhost/api/v1/knowledge/documents/${created.document.id}`, cookie), { params: Promise.resolve({ id: created.document.id }) })).json();
    expect(detail.data.versions).toHaveLength(1);
    expect(detail.data.versions[0]).toMatchObject({ version: 1, fileName: "intern-2026.pdf", sizeBytes: pdf().byteLength });
    expect(detail.data.accessBasis).toBe("owner");

    const downloaded = await downloadVersion(getRequest(`http://localhost/api/v1/knowledge/documents/${created.document.id}/versions/1/content`, cookie), { params: Promise.resolve({ id: created.document.id, version: "1" }) });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("application/pdf");
    expect(downloaded.headers.get("x-content-digest")).toBe(created.version.contentDigest);
    expect(downloaded.headers.get("content-disposition")).toContain("intern-2026.pdf");
    expect(Array.from(new Uint8Array(await downloaded.arrayBuffer()))).toEqual(Array.from(pdf()));
  });

  it("追加版本走同一个入口，历史版本仍能下载", async () => {
    const cookie = await setup();
    const created = (await (await uploadFile(multipart({
      title: "转正评估标准", category: "standard", classification: "internal",
    }, { name: "v1.pdf", type: "application/pdf", bytes: pdf() }, cookie))).json()).data;

    const secondBytes = new Uint8Array([...pdf(), 0x21]);
    const appended = await appendVersion(multipart({
      title: "转正评估标准（修订）", category: "standard", classification: "internal",
    }, { name: "v2.pdf", type: "application/pdf", bytes: secondBytes }, cookie), { params: Promise.resolve({ id: created.document.id }) });
    expect(appended.status).toBe(201);
    expect((await appended.json()).data.document.currentVersion).toBe(2);

    const v1 = await downloadVersion(getRequest(`http://localhost/api/v1/knowledge/documents/${created.document.id}/versions/1/content`, cookie), { params: Promise.resolve({ id: created.document.id, version: "1" }) });
    expect(Array.from(new Uint8Array(await v1.arrayBuffer()))).toEqual(Array.from(pdf()));
    const v2 = await downloadVersion(getRequest(`http://localhost/api/v1/knowledge/documents/${created.document.id}/versions/2/content`, cookie), { params: Promise.resolve({ id: created.document.id, version: "2" }) });
    expect(Array.from(new Uint8Array(await v2.arrayBuffer()))).toEqual(Array.from(secondBytes));
  });

  it("文本型条目走原入口不受影响，且能按 kind=text 过滤", async () => {
    const cookie = await setup();
    const published = await publishText(jsonRequest("http://localhost/api/v1/knowledge/documents", {
      title: "培训管理制度", content: "第一条 培训计划由部门负责人提出。", classification: "internal", category: "policy", summary: "培训流程与责任。",
    }, cookie));
    expect(published.status).toBe(201);
    const listed = await (await listLibrary(getRequest("http://localhost/api/v1/knowledge/documents?kind=text", cookie))).json();
    expect(listed.data.documents.every((item: { kind: string }) => item.kind === "text")).toBe(true);
    expect(listed.data.documents.some((item: { title: string }) => item.title === "培训管理制度")).toBe(true);
  });

  it("上传约束：超大 413、类型不允许 422、缺文件 422、非 multipart 422", async () => {
    const cookie = await setup();
    const tooLarge = await uploadFile(multipart({
      title: "超大附件", category: "record", classification: "internal",
    }, { name: "big.pdf", type: "application/pdf", bytes: new Uint8Array(26 * 1024 * 1024) }, cookie));
    expect(tooLarge.status).toBe(413);

    const wrongType = await uploadFile(multipart({
      title: "可执行文件", category: "record", classification: "internal",
    }, { name: "run.exe", type: "application/x-msdownload", bytes: pdf() }, cookie));
    expect(wrongType.status).toBe(422);

    const missing = await uploadFile(multipart({ title: "没有文件", category: "record", classification: "internal" }, undefined, cookie));
    expect(missing.status).toBe(422);

    const notMultipart = await publishText(jsonRequest("http://localhost/api/v1/knowledge/documents/files", { title: "走错入口" }, cookie));
    expect([404, 405, 422]).toContain(notMultipart.status);
  });

  it("越权与不存在的条目都返回 404（不泄露存在性）", async () => {
    const cookie = await setup();
    const created = (await (await uploadFile(multipart({
      title: "机密协议", category: "agreement", classification: "confidential",
      allowedUserIds: "10000000-0000-4000-8000-000000000009",
    }, { name: "secret.pdf", type: "application/pdf", bytes: pdf() }, cookie))).json()).data;

    // 同一租户的普通同事：没有白名单、角色、部门或岗位命中 → 机密条目不给他看，也不告诉他"存在"。
    const delivery = await identityCookie("delivery");
    const denied = await downloadVersion(getRequest(`http://localhost/api/v1/knowledge/documents/${created.document.id}/versions/1/content`, delivery), { params: Promise.resolve({ id: created.document.id, version: "1" }) });
    expect(denied.status).toBe(404);
    const deniedDetail = await describeDocument(getRequest(`http://localhost/api/v1/knowledge/documents/${created.document.id}`, delivery), { params: Promise.resolve({ id: created.document.id }) });
    expect(deniedDetail.status).toBe(404);
    const deniedList = await (await listLibrary(getRequest("http://localhost/api/v1/knowledge/documents", delivery))).json();
    expect(deniedList.data.documents.map((item: { id: string }) => item.id)).not.toContain(created.document.id);

    const missing = await downloadVersion(getRequest(`http://localhost/api/v1/knowledge/documents/11111111-1111-4111-8111-111111111111/versions/1/content`, cookie), { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111", version: "1" }) });
    expect(missing.status).toBe(404);
    // 说明：开发模式下没有会话 Cookie 会落到开发身份（不是"匿名可读"）；生产由鉴权入口失败关闭。
  });
});
