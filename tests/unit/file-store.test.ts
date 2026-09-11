// Requirements: PR-004, MR-006, SR-002, AC-012（E-161：企业文件库的本地磁盘对象存储）
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryFileStore,
  LocalDiskFileStore,
  buildStorageRef,
  createFileObjectStore,
  digestBytes,
  parseStorageRef,
} from "@/src/platform/storage/file-store";

const TENANT = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-0000000000ff";

let root: string;

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "nexus-files-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("E-161 文件存储（本地磁盘）", () => {
  it("内容寻址写入：同一份字节只存一份，摘要即文件名", async () => {
    const store = new LocalDiskFileStore(root);
    const bytes = new TextEncoder().encode("实习生协议正文");
    const first = await store.put({ tenantId: TENANT, bytes });
    const second = await store.put({ tenantId: TENANT, bytes });

    expect(first.contentDigest).toBe(digestBytes(bytes));
    expect(first.storageRef).toBe(`local://${TENANT}/${first.contentDigest.slice(0, 2)}/${first.contentDigest.slice(2, 4)}/${first.contentDigest}`);
    expect(first.sizeBytes).toBe(bytes.byteLength);
    expect(second.storageRef).toBe(first.storageRef);
  });

  it("写入后能按引用读回原始字节，删除后读回失败", async () => {
    const store = new LocalDiskFileStore(root);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
    const stored = await store.put({ tenantId: TENANT, bytes });

    expect(Array.from(await store.get(stored.storageRef))).toEqual(Array.from(bytes));
    await store.delete(stored.storageRef);
    await expect(store.get(stored.storageRef)).rejects.toThrow("FILE_OBJECT_NOT_FOUND");
  });

  it("不同租户的相同内容各自独立（引用里带租户）", async () => {
    const store = new LocalDiskFileStore(root);
    const bytes = new TextEncoder().encode("同一份内容");
    const a = await store.put({ tenantId: TENANT, bytes });
    const b = await store.put({ tenantId: TENANT_B, bytes });
    expect(a.storageRef).not.toBe(b.storageRef);
    expect(Array.from(await store.get(a.storageRef))).toEqual(Array.from(bytes));
  });

  it("拒绝越权/畸形引用：目录穿越、非本实现前缀、摘要不符合规范", async () => {
    const store = new LocalDiskFileStore(root);
    for (const bad of [
      "local://../../../etc/passwd",
      "local://" + TENANT + "/ab/cd/../../../../etc/passwd",
      "s3://bucket/key",
      "memory://artifact/x",
      `local://${TENANT}/ab/cd/not-a-digest`,
    ]) {
      await expect(store.get(bad)).rejects.toThrow("FILE_STORAGE_REF_INVALID");
    }
    expect(() => parseStorageRef(`local://${TENANT}/ab/cd/${"f".repeat(64)}`)).not.toThrow();
    expect(() => buildStorageRef(TENANT, "z".repeat(64))).not.toThrow();
  });

  it("磁盘上的字节被改动后读取会报摘要不匹配（完整性校验）", async () => {
    const store = new LocalDiskFileStore(root);
    const stored = await store.put({ tenantId: TENANT, bytes: new TextEncoder().encode("原始内容") });
    const parsed = parseStorageRef(stored.storageRef);
    await mkdir(path.dirname(path.join(root, parsed.relativePath)), { recursive: true });
    await writeFile(path.join(root, parsed.relativePath), "被篡改的内容");

    await expect(store.get(stored.storageRef)).rejects.toThrow("FILE_OBJECT_CORRUPTED");
  });

  it("空文件拒绝写入", async () => {
    const store = new LocalDiskFileStore(root);
    await expect(store.put({ tenantId: TENANT, bytes: new Uint8Array() })).rejects.toThrow("FILE_EMPTY");
  });

  it("环境变量映射：默认开发目录、显式根目录、内存 provider、生产未配置失败关闭", () => {
    const memory = createFileObjectStore({ NEXUS_FILE_STORAGE_PROVIDER: "memory" });
    expect(memory).toBeInstanceOf(InMemoryFileStore);

    const explicit = createFileObjectStore({ NEXUS_FILE_STORAGE_ROOT: root });
    expect(explicit).toBeInstanceOf(LocalDiskFileStore);

    const development = createFileObjectStore({});
    expect(development).toBeInstanceOf(LocalDiskFileStore);

    expect(() => createFileObjectStore({ NODE_ENV: "production" })).toThrow("FILE_STORAGE_NOT_CONFIGURED");
    expect(() => createFileObjectStore({ NODE_ENV: "production", NEXUS_FILE_STORAGE_PROVIDER: "memory" })).toThrow("FILE_STORAGE_MEMORY_FORBIDDEN_IN_PRODUCTION");
    expect(createFileObjectStore({ NODE_ENV: "production", NEXUS_FILE_STORAGE_ROOT: root })).toBeInstanceOf(LocalDiskFileStore);
  });

  it("内存实现与磁盘实现同语义（测试与演示环境用）", async () => {
    const store = new InMemoryFileStore();
    const bytes = new TextEncoder().encode("内存里的文件");
    const stored = await store.put({ tenantId: TENANT, bytes });
    expect(Array.from(await store.get(stored.storageRef))).toEqual(Array.from(bytes));
    await store.delete(stored.storageRef);
    await expect(store.get(stored.storageRef)).rejects.toThrow("FILE_OBJECT_NOT_FOUND");
  });
});
