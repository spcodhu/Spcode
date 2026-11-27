import { SyncTaskClient } from "./sync-task-client.js";

export interface ObjectArtifactBackend {
  put(key: string, encodedContent: Buffer, contentType?: string): void;
  get(key: string): Buffer;
  delete(key: string): void;
}

export interface S3ArtifactOptions {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  forcePathStyle?: boolean;
  prefix?: string;
  workerFile: URL;
}

/** S3/OSS 兼容对象存储；凭据只存在 workerData，不进入数据库或 Artifact 元数据。 */
export class S3ObjectBackend implements ObjectArtifactBackend {
  private readonly client: SyncTaskClient;

  constructor(private readonly options: S3ArtifactOptions) {
    this.client = new SyncTaskClient(
      {
        config: {
          endpoint: options.endpoint,
          region: options.region,
          forcePathStyle: options.forcePathStyle !== false,
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
            ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
          },
        },
      },
      options.workerFile,
    );
  }

  put(key: string, encodedContent: Buffer, contentType = "application/octet-stream"): void {
    this.client.call({
      op: "put",
      bucket: this.options.bucket,
      key: this.key(key),
      body: encodedContent.toString("base64"),
      contentType,
    });
  }

  get(key: string): Buffer {
    const result = this.client.call<{ body: string }>({ op: "get", bucket: this.options.bucket, key: this.key(key) });
    return Buffer.from(result.body, "utf8");
  }

  delete(key: string): void {
    this.client.call({ op: "delete", bucket: this.options.bucket, key: this.key(key) });
  }

  close(): void {
    this.client.close();
  }

  private key(key: string): string {
    return `${this.options.prefix ?? "spcode/artifacts/"}${key}.bin`;
  }
}
