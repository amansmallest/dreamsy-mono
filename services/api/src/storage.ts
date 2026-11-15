import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/** Blob store for packages and uploads. Keys are content-addressed where possible. */
export interface Storage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
}

export class MemoryStorage implements Storage {
  readonly objects = new Map<string, { body: Uint8Array<ArrayBuffer>; contentType: string }>();
  async put(key: string, body: Uint8Array, contentType: string) {
    this.objects.set(key, { body: new Uint8Array(body), contentType });
  }
  async get(key: string) {
    return this.objects.get(key)?.body ?? null;
  }
}

/** Dev storage: one file per key under a directory. Keys are our own (packages/<sha>.zip, uploads/<id>). */
export class FsStorage implements Storage {
  constructor(private readonly dir: string) {}

  private path(key: string) {
    if (key.includes("..") || key.startsWith("/")) throw new Error(`bad storage key: ${key}`);
    return join(this.dir, key);
  }

  async put(key: string, body: Uint8Array) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }

  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
}

export class S3Storage implements Storage {
  constructor(private client: S3Client, private bucket: string) {}

  static fromEnv(env: NodeJS.ProcessEnv): S3Storage {
    const client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION ?? "us-east-1",
      forcePathStyle: Boolean(env.S3_ENDPOINT),
      credentials: env.S3_ACCESS_KEY_ID
        ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "" }
        : undefined,
    });
    const bucket = env.S3_BUCKET;
    if (!bucket) throw new Error("S3_BUCKET is required");
    return new S3Storage(client, bucket);
  }

  async put(key: string, body: Uint8Array, contentType: string) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string) {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.Body ? ((await res.Body.transformToByteArray()) as Uint8Array<ArrayBuffer>) : null;
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      throw err;
    }
  }
}
