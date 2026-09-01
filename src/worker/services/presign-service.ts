import { AwsClient } from "aws4fetch";
import type { Env } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import { DEFAULT_LIMITS } from "../../shared/constants";

export interface PresignedUrlResult {
  uploadUrl: string;
  method: "PUT";
  headers: {
    "Content-Type": string;
  };
  expiresAt: number;
}

export async function createPresignedPutUrl(
  env: Env,
  objectKey: string,
  contentType: string,
  ttlSeconds: number = DEFAULT_LIMITS.PRESIGNED_URL_TTL_SECONDS
): Promise<PresignedUrlResult> {
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const bucketName = env.R2_BUCKET_NAME?.trim();

  if (!accessKeyId || !secretAccessKey || !accountId || !bucketName) {
    throw new AppError(
      503,
      ERROR_CODES.SERVICE_UNAVAILABLE,
      "R2 S3 credentials and bucket configuration are not complete on this server."
    );
  }

  const aws = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region: "auto"
  });

  const url = new URL(
    `https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${objectKey}`
  );
  url.searchParams.set("X-Amz-Expires", String(ttlSeconds));

  const request = new Request(url.toString(), {
    method: "PUT",
    headers: {
      "Content-Type": contentType
    }
  });

  const signed = await aws.sign(request, {
    aws: {
      signQuery: true
    }
  });

  const expiresAt = Date.now() + ttlSeconds * 1000;

  return {
    uploadUrl: signed.url,
    method: "PUT",
    headers: {
      "Content-Type": contentType
    },
    expiresAt
  };
}
