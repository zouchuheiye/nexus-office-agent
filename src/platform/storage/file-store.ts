import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 企业信息库（E-161）：文件字节的存放抽象。
 *
 * 起步用**本地磁盘目录**（用户确认的方案）：单机/内网部署最简单，接口层保持抽象——
 * 将来换 S3/MinIO 兼容对象存储只要再写一个 `FileObjectStore` 实现，业务代码不动。
 *
 * 约定与边界：
 * - `storageRef` 形如 `local://<tenantId>/<sha256 前2位>/<sha256 第3-4位>/<sha256>`：
 *   内容寻址（同一份字节只存一份）、按租户隔离目录、天然可做完整性校验。
 * - 读取时**必须**校验引用形状与最终路径仍落在根目录内（防目录穿越），并校验字节摘要与引用一致。
 * - 生产环境没有显式配置根目录时**失败关闭**（`FILE_STORAGE_NOT_CONFIGURED`）：不允许悄悄写到容器临时目录，
 *   否则"上传成功、重启即丢"。开发环境默认写到仓库下的 `.nexus-files/`。
 */
export type StoredFileObject = { storageRef: string; sizeBytes: number; contentDigest: string };

export interface FileObjectStore {
  put(input: { tenantId: string; bytes: Uint8Array }): Promise<StoredFileObject>;
  get(storageRef: string): Promise<Uint8Array>;
  delete(storageRef: string): Promise<void>;
}

export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const REF_PATTERN = /^local:\/\/([0-9a-f-]{36})\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})$/;

export function buildStorageRef(tenantId: string, contentDigest: string): string {
  return `local://${tenantId}/${contentDigest.slice(0, 2)}/${contentDigest.slice(2, 4)}/${contentDigest}`;
}

export function parseStorageRef(storageRef: string): { tenantId: string; contentDigest: string; relativePath: string } {
  const match = REF_PATTERN.exec(storageRef);
  if (!match) throw new Error("FILE_STORAGE_REF_INVALID");
  const [, tenantId, first, second, contentDigest] = match;
  return { tenantId, contentDigest, relativePath: path.join(tenantId, first, second, contentDigest) };
}

export class LocalDiskFileStore implements FileObjectStore {
  constructor(private readonly root: string) {}

  async put(input: { tenantId: string; bytes: Uint8Array }): Promise<StoredFileObject> {
    if (!input.bytes.byteLength) throw new Error("FILE_EMPTY");
    const contentDigest = digestBytes(input.bytes);
    const storageRef = buildStorageRef(input.tenantId, contentDigest);
    const target = this.absolutePath(storageRef);
    await mkdir(path.dirname(target), { recursive: true });
    // 内容寻址：已经存在同样摘要的对象就不再写第二遍（并发写下同一份内容也安全）。
    try {
      const existing = await stat(target);
      if (existing.isFile() && existing.size === input.bytes.byteLength) return { storageRef, sizeBytes: input.bytes.byteLength, contentDigest };
    } catch { /* 不存在，继续写 */ }
    await writeFile(target, input.bytes, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    return { storageRef, sizeBytes: input.bytes.byteLength, contentDigest };
  }

  async get(storageRef: string): Promise<Uint8Array> {
    const parsed = parseStorageRef(storageRef);
    const bytes = await readFile(this.absolutePath(storageRef)).catch(() => { throw new Error("FILE_OBJECT_NOT_FOUND"); });
    if (digestBytes(bytes) !== parsed.contentDigest) throw new Error("FILE_OBJECT_CORRUPTED");
    return new Uint8Array(bytes);
  }

  async delete(storageRef: string): Promise<void> {
    parseStorageRef(storageRef);
    await rm(this.absolutePath(storageRef), { force: true });
  }

  /** 只接受本实现的引用形状，并再次确认最终路径没有跑出根目录。 */
  private absolutePath(storageRef: string): string {
    const { relativePath } = parseStorageRef(storageRef);
    const root = path.resolve(this.root);
    const target = path.resolve(root, relativePath);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error("FILE_STORAGE_REF_INVALID");
    return target;
  }
}

export class InMemoryFileStore implements FileObjectStore {
  private readonly objects = new Map<string, Uint8Array>();

  async put(input: { tenantId: string; bytes: Uint8Array }): Promise<StoredFileObject> {
    if (!input.bytes.byteLength) throw new Error("FILE_EMPTY");
    const contentDigest = digestBytes(input.bytes);
    const storageRef = buildStorageRef(input.tenantId, contentDigest);
    if (!this.objects.has(storageRef)) this.objects.set(storageRef, new Uint8Array(input.bytes));
    return { storageRef, sizeBytes: input.bytes.byteLength, contentDigest };
  }

  async get(storageRef: string): Promise<Uint8Array> {
    const parsed = parseStorageRef(storageRef);
    const bytes = this.objects.get(storageRef);
    if (!bytes) throw new Error("FILE_OBJECT_NOT_FOUND");
    if (digestBytes(bytes) !== parsed.contentDigest) throw new Error("FILE_OBJECT_CORRUPTED");
    return new Uint8Array(bytes);
  }

  async delete(storageRef: string): Promise<void> {
    parseStorageRef(storageRef);
    this.objects.delete(storageRef);
  }
}

export const DEFAULT_DEVELOPMENT_FILE_ROOT = ".nexus-files";

/**
 * 唯一的"环境变量 → 文件存储"映射点。
 * `NEXUS_FILE_STORAGE_PROVIDER=memory` 只允许在非生产环境使用（测试/演示用）。
 */
export function createFileObjectStore(env: Record<string, string | undefined> = process.env): FileObjectStore {
  if (env.NEXUS_FILE_STORAGE_PROVIDER === "memory") {
    if (env.NODE_ENV === "production") throw new Error("FILE_STORAGE_MEMORY_FORBIDDEN_IN_PRODUCTION");
    return new InMemoryFileStore();
  }
  const root = env.NEXUS_FILE_STORAGE_ROOT?.trim();
  if (root) return new LocalDiskFileStore(root);
  if (env.NODE_ENV === "production") throw new Error("FILE_STORAGE_NOT_CONFIGURED");
  return new LocalDiskFileStore(path.resolve(process.cwd(), DEFAULT_DEVELOPMENT_FILE_ROOT));
}
