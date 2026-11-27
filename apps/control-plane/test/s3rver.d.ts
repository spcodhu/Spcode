declare module "s3rver" {
  export default class S3rver {
    constructor(options: {
      directory: string;
      configureBuckets?: Array<{ name: string }>;
      address?: string;
      port?: number;
    });
    run(): Promise<{ port: number }>;
    close(): Promise<void>;
    address(): { port: number };
  }
}
